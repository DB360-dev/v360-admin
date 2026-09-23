-- =====================================================================
-- 006_ops_portal.sql — What the Admin panel (V360 + KBB) needs.
--   * Operational notes on an order (no status change)
--   * Status counts for dashboards
--   * Views: dispatches with brand name, shipments with order counts,
--     team members (users + roles + organizations)
-- =====================================================================

-- ---------- Operational note ----------------------------------------

create function add_order_note(p_order_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_v360() or is_partner()) then raise exception 'Only V360 or KBB can add notes'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Write a note first'; end if;
  if not exists (select 1 from orders where id = p_order_id) then raise exception 'Order not found'; end if;
  perform _log_order_event(p_order_id, 'Note added', left(trim(p_note), 2000));
end $$;

-- ---------- Counts (RLS applies) ------------------------------------

create function ops_order_counts()
returns table (status order_status, count bigint)
language sql stable security invoker set search_path = public as $$
  select o.status, count(*) from orders o group by o.status
$$;

-- ---------- Dispatches: add brand name (appended column) -------------

create or replace view inbound_batch_overview with (security_invoker = true) as
select
  b.id, b.brand_id, b.courier, b.tracking_number, b.dispatch_date, b.status, b.courier_status,
  b.notes, b.created_at, b.received_at,
  count(o.id)                                                          as order_count,
  count(o.id) filter (where o.status = 'dispatched_to_hub')            as awaiting_count,
  count(o.id) filter (where o.status = 'hub_issue')                    as issue_count,
  count(o.id) filter (where o.status not in ('dispatched_to_hub', 'hub_issue')) as received_count,
  (select name from organizations g where g.id = b.brand_id)           as brand_name
from inbound_batches b
left join orders o on o.inbound_batch_id = b.id
group by b.id;

-- ---------- Shipments overview --------------------------------------

create view shipment_overview with (security_invoker = true) as
select
  s.id, s.code, s.shipping_partner, s.tracking_number, s.origin, s.destination, s.total_weight_kg,
  s.status, s.notes, s.created_at, s.dispatched_at, s.received_at,
  count(o.id)                        as order_count,
  count(distinct o.brand_id)         as brand_count,
  coalesce(sum(o.cod_amount_expected), 0) as cod_expected
from shipments s
left join orders o on o.shipment_id = s.id
group by s.id;

-- ---------- Team members ---------------------------------------------

create view team_members with (security_invoker = true) as
select
  m.id as membership_id, m.user_id, m.role, m.created_at,
  p.full_name, p.email, p.phone,
  o.id as organization_id, o.name as organization_name, o.type as organization_type
from memberships m
join organizations o on o.id = m.organization_id
left join profiles p on p.id = m.user_id;

-- ---------- Privileges -----------------------------------------------

revoke execute on function add_order_note(uuid, text), ops_order_counts() from public, anon, authenticated;
grant execute on function add_order_note(uuid, text), ops_order_counts() to authenticated;

revoke all on shipment_overview, team_members from anon;
grant select on inbound_batch_overview, shipment_overview, team_members to authenticated;
