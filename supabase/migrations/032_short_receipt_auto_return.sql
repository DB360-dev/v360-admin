-- =====================================================================
-- 032_short_receipt_auto_return.sql
--
-- When KBB confirms receiving a shipment, every order with an item that
-- arrived short (received < dispatched) is automatically marked RETURNED:
--   * units KBB received            -> restocked in Bangladesh
--   * units the brand sent from BD stock (never shipped) -> back to BD stock
--   * units not received            -> still in the Pakistan warehouse; they
--                                      stay listed on Discrepancies
-- The order-level return decision is saved automatically, so the order
-- follows the normal returns path (incl. the 50% advance clawback on the
-- final settlement invoice).
--
-- Discrepancies can be marked resolved / un-resolved (V360 and the brand,
-- optional note). Everyone who can see a discrepancy sees its resolution.
-- =====================================================================

-- ---------- Restock quantity per line --------------------------------
-- Units of a line that went into BD stock. NULL = the whole line (the
-- behaviour of manual "Restock in BD" decisions until now).
alter table order_items add column if not exists restock_qty int
  check (restock_qty is null or restock_qty >= 0);

-- Live definition of bd_restocked_items (read from the database on
-- 2026-09-25), with quantity / available_qty / line_total now counting only
-- the restocked units. Column names and types are unchanged.
create or replace view bd_restocked_items with (security_invoker = true) as
 SELECT oi.id AS order_item_id,
    o.id AS order_id,
    o.order_number,
    o.order_date,
    o.status,
    o.status_changed_at AS returned_at,
    o.brand_id,
    b.name AS brand_name,
    o.customer_name,
    o.customer_phone,
    o.city,
    o.province,
    o.order_total,
    o.currency,
    o.delivered_at,
    o.delivery_courier,
    o.delivery_tracking_number,
    o.failure_reason,
    oi.return_disposition,
    rd.created_at AS restocked_at,
    rd.note AS restock_note,
    s.id AS shipment_id,
    s.code AS shipment_code,
    oi.product_name,
    oi.sku,
    oi.variant,
    COALESCE(oi.restock_qty, oi.quantity) AS quantity,
    oi.qty_dispatched_from_restock AS dispatched_qty,
    GREATEST(0, COALESCE(oi.restock_qty, oi.quantity) - oi.qty_dispatched_from_restock) AS available_qty,
    oi.unit_price,
    oi.discount,
    COALESCE(oi.restock_qty, oi.quantity)::numeric * oi.unit_price - oi.discount AS line_total
   FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN organizations b ON b.id = o.brand_id
     LEFT JOIN shipments s ON s.id = o.shipment_id
     LEFT JOIN LATERAL ( SELECT e.created_at,
            e.note
           FROM order_events e
          WHERE e.order_id = o.id AND e.action = 'Return disposition saved'::text
          ORDER BY e.created_at DESC
         LIMIT 1) rd ON true
  WHERE oi.return_disposition = 'restock_in_bd'::return_disposition
    AND COALESCE(oi.restock_qty, oi.quantity) > 0;

-- ---------- Auto-return one short order ------------------------------
create or replace function _auto_return_short_order(p_order_id uuid, p_shipment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  o         orders%rowtype;
  v_code    text := (select code from shipments where id = p_shipment_id);
  v_bd      int := 0;   -- units restocked in BD
  v_missing int := 0;   -- units still in Pakistan
begin
  select * into o from orders where id = p_order_id for update;
  if not found or o.status in ('returned', 'cancelled', 'delivered') then return; end if;

  -- Per line: BD units = received PK units + units the brand sent from BD stock.
  with lines as (
    select oi.id,
           oi.quantity,
           order_item_hub_qty(oi.quantity, oi.inventory_qty, oi.fulfilment_origin) as hub_qty,
           r.received_qty
    from order_items oi
    left join bd_received_items r on r.order_item_id = oi.id and r.shipment_id = p_shipment_id
    where oi.order_id = p_order_id
  ), calc as (
    select id,
           least(quantity, greatest(0, coalesce(received_qty, hub_qty)) + (quantity - hub_qty)) as bd_qty,
           greatest(0, hub_qty - coalesce(received_qty, hub_qty)) as missing_qty
    from lines
  ), upd as (
    update order_items oi set
      restock_qty        = c.bd_qty,
      return_disposition = case when c.bd_qty > 0 then 'restock_in_bd' else 'return_to_pk' end::return_disposition
    from calc c where oi.id = c.id
    returning c.bd_qty, c.missing_qty
  )
  select coalesce(sum(bd_qty), 0), coalesce(sum(missing_qty), 0) into v_bd, v_missing from upd;

  perform _set_order_status(p_order_id, 'returned', 'Returned: items not received by KBB',
    'Shipment ' || v_code || ': ' || v_missing || ' unit(s) not received (still in Pakistan)');

  update orders set return_disposition =
    case when v_bd > 0 then 'restock_in_bd' else 'return_to_pk' end::return_disposition
  where id = p_order_id;

  perform _log_order_event(p_order_id, 'Return disposition saved',
    'Automatic: ' || v_bd || ' unit(s) restocked in Bangladesh, '
    || v_missing || ' unit(s) not received — still in the Pakistan warehouse');
end $$;

revoke all on function _auto_return_short_order(uuid, uuid) from public, anon, authenticated;

-- ---------- Confirm receiving: now auto-returns short orders ---------
-- Same checks as 028; after the shipment moves to received_by_partner,
-- every order with a short line is returned.
create or replace function bd_confirm_shipment_receiving(
  p_shipment_id uuid,
  p_override    boolean default false
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_unchecked   int;
  v_undisclosed int;
  v_order       uuid;
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Not authorised';
  end if;

  if p_override and not is_v360() then
    raise exception 'Only V360 admins can override receiving discrepancies';
  end if;

  select count(*) into v_unchecked
  from orders o
  join order_items oi on oi.order_id = o.id
  where o.shipment_id = p_shipment_id
    and order_item_hub_qty(oi.quantity, oi.inventory_qty, oi.fulfilment_origin) > 0
    and not exists (
      select 1 from bd_received_items r
      where r.shipment_id = p_shipment_id and r.order_item_id = oi.id
    );

  if v_unchecked > 0 then
    raise exception '% item(s) have not been checked yet', v_unchecked;
  end if;

  if not p_override then
    select count(*) into v_undisclosed
    from bd_received_items
    where shipment_id = p_shipment_id
      and received_qty <> expected_qty
      and (note is null or trim(note) = '');

    if v_undisclosed > 0 then
      raise exception '% discrepancy(s) need a note before confirming', v_undisclosed;
    end if;
  end if;

  perform set_shipment_status(p_shipment_id, 'received_by_partner',
    case when p_override then 'BD receiving completed with override by V360'
         else 'BD receiving check completed' end);

  for v_order in
    select distinct r.order_id from bd_received_items r
    join orders o on o.id = r.order_id and o.shipment_id = p_shipment_id
    where r.shipment_id = p_shipment_id and r.received_qty < r.expected_qty
  loop
    perform _auto_return_short_order(v_order, p_shipment_id);
  end loop;
end $$;

-- ---------- Discrepancy resolution -----------------------------------
alter table bd_received_items
  add column if not exists resolved_at     timestamptz,
  add column if not exists resolved_by     uuid references profiles(id),
  add column if not exists resolution_note text;

-- Brands can read receiving checks of their own orders.
drop policy if exists bd_receiving_brand_select on bd_received_items;
create policy bd_receiving_brand_select on bd_received_items
  for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)));

create or replace function set_discrepancy_resolved(p_id uuid, p_resolved boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  r bd_received_items%rowtype;
  v_brand uuid;
  v_order text;
begin
  select * into r from bd_received_items where id = p_id for update;
  if not found or r.received_qty = r.expected_qty then raise exception 'Discrepancy not found'; end if;
  select brand_id, order_number into v_brand, v_order from orders where id = r.order_id;
  if not (is_v360() or is_brand_member(v_brand)) then
    raise exception 'Only V360 or the brand can resolve discrepancies';
  end if;

  update bd_received_items set
    resolved_at     = case when p_resolved then now() else null end,
    resolved_by     = case when p_resolved then auth.uid() else null end,
    resolution_note = case when p_resolved then nullif(trim(coalesce(p_note, '')), '') else null end
  where id = p_id;

  perform _log_order_event(r.order_id,
    case when p_resolved then 'Discrepancy resolved' else 'Discrepancy reopened' end,
    (select product_name from order_items where id = r.order_item_id)
      || coalesce(' — ' || nullif(trim(coalesce(p_note, '')), ''), ''));
end $$;

grant execute on function set_discrepancy_resolved(uuid, boolean, text) to authenticated;

-- New view for the Discrepancies pages (ops + brand portal). The older
-- bd_discrepancies view is left untouched. Left joins so brand users, who
-- may not read shipments, still see their rows.
create or replace view bd_discrepancy_items with (security_invoker = true) as
select
  r.id,
  r.shipment_id,
  r.order_id,
  r.order_item_id,
  r.expected_qty,
  r.received_qty,
  r.received_qty - r.expected_qty as difference,
  r.note,
  r.checked_at,
  r.resolved_at,
  r.resolution_note,
  rp.full_name  as resolved_by_name,
  s.code        as shipment_code,
  o.order_number,
  o.status      as order_status,
  o.brand_id,
  b.name        as brand_name,
  oi.product_name,
  oi.sku,
  oi.variant
from bd_received_items r
join orders            o  on o.id  = r.order_id
join order_items       oi on oi.id = r.order_item_id
left join shipments    s  on s.id  = r.shipment_id
left join organizations b on b.id  = o.brand_id
left join profiles     rp on rp.id = r.resolved_by
where r.received_qty <> r.expected_qty;

grant select on bd_discrepancy_items to authenticated;
