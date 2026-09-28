-- =====================================================================
-- 048_warehouse_role.sql
-- V360 warehouse staff: members of the V360 organization with role
-- 'warehouse'. They run the Lahore hub (receive brand parcels, build and
-- dispatch shipments) and must never see money, payments or invoices.
--
-- is_v360() used to mean "any V360 member". It now means V360 admin or
-- operator only, so every existing V360 check (money, invoices, payouts,
-- brands, FX, webhooks, overrides, returns...) excludes warehouse staff
-- without touching each one. Warehouse access is then granted back
-- explicitly below via is_v360_warehouse().
-- =====================================================================

-- ---------- Who is calling? -----------------------------------------

create or replace function is_v360() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'v360' and m.role in ('admin', 'operator') and o.is_active
  )
$$;

create or replace function is_v360_warehouse() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'v360' and m.role = 'warehouse' and o.is_active
  )
$$;

revoke all on function is_v360_warehouse() from public, anon;
grant execute on function is_v360_warehouse() to authenticated;

-- 'warehouse' is its own actor group so change_order_status only allows
-- the moves listed for it in status_transitions (V360 may make any move).
create or replace function actor_group_for(p_brand_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when is_v360() then 'v360'
    when is_v360_warehouse() then 'warehouse'
    when is_partner() then 'partner'
    when is_brand_member(p_brand_id) then 'brand'
    else null end
$$;

alter table status_transitions drop constraint if exists status_transitions_actor_check;
alter table status_transitions add constraint status_transitions_actor_check
  check (actor in ('partner', 'brand', 'v360', 'warehouse'));

insert into status_transitions (from_status, to_status, actor) values
  ('received_at_hub', 'ready_for_shipment', 'warehouse')
on conflict do nothing;

-- ---------- Hub actions warehouse staff may take ---------------------
-- Re-create each function from its live definition with
-- is_v360() -> (is_v360() or is_v360_warehouse()). Using the live body
-- keeps every later fix (receive_order has been replaced several times).
-- Grants survive create or replace.

do $$
declare
  r     record;
  v_def text;
  v_new text;
  v_fns text[] := array[
    'receive_order',              -- hub receiving (+ item weights)
    'accept_bd_stock_order',      -- accept orders fulfilled from BD stock
    'create_shipment',
    'create_shipment_with_orders',
    'add_orders_to_shipment',
    'remove_order_from_shipment',
    'set_shipment_status',        -- dispatch; brand shipping invoices are created by a trigger, not the caller
    'hold_order',
    'resume_order',
    'add_order_note'
  ];
  v_done text[] := '{}';
begin
  for r in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(v_fns)
  loop
    v_def := pg_get_functiondef(r.oid);
    if position('is_v360_warehouse()' in v_def) > 0 then
      v_done := v_done || r.proname::text;   -- already migrated
      continue;
    end if;
    v_new := replace(v_def, 'is_v360()', '(is_v360() or is_v360_warehouse())');
    if v_new = v_def then
      raise exception 'Function % has no is_v360() check; review it before granting warehouse access', r.proname;
    end if;
    execute v_new;
    v_done := v_done || r.proname::text;
  end loop;

  if exists (select 1 from unnest(v_fns) f where f <> all (v_done)) then
    raise exception 'Missing functions: %', (select array_agg(f) from unnest(v_fns) f where f <> all (v_done));
  end if;
end $$;

-- ---------- Read access ----------------------------------------------
-- Operational tables only. Money tables (invoices, settlements, payments,
-- brand_shipping_invoices, brand_money_settings, shipment_brand_weights)
-- keep their is_v360() / is_partner() policies, so warehouse sees nothing.

alter policy org_read on organizations
  using (is_v360() or is_v360_warehouse() or is_partner()
         or id in (select organization_id from memberships where user_id = auth.uid()));

alter policy orders_read on orders
  using (is_v360() or is_v360_warehouse() or is_partner() or is_brand_member(brand_id));

alter policy inbound_read on inbound_batches
  using (is_v360() or is_v360_warehouse() or is_brand_member(brand_id));

alter policy shipments_read on shipments
  using (
    is_v360() or is_v360_warehouse()
    or (is_partner() and status >= 'handed_to_carrier')
    or exists (select 1 from orders o where o.shipment_id = shipments.id and is_brand_member(o.brand_id))
  );

-- Shipping partner / tracking / notes are edited directly on the row.
alter policy shipments_update on shipments
  using (is_v360() or is_v360_warehouse())
  with check (is_v360() or is_v360_warehouse());

-- Parcel weights recorded at hub receiving (shown when building shipments).
alter policy order_weight_read on order_freight_weights
  using (is_v360() or is_v360_warehouse() or is_partner()
         or exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)));

-- Discrepancies / inventory pages: read only.
alter policy bd_receiving_select on bd_received_items
  using (is_v360() or is_v360_warehouse() or is_partner());
