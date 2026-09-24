-- =====================================================================
-- 022_bd_receiving_hold.sql
-- • bd_save_order_receiving: auto-hold orders when a discrepancy is
--   found, auto-resume when re-check shows all quantities match.
-- • bd_discrepancies view: adds order_status so the UI can show
--   the hold badge alongside each discrepant item.
-- =====================================================================

create or replace function bd_save_order_receiving(
  p_shipment_id uuid,
  p_order_id    uuid,
  p_items       jsonb
)
returns void language plpgsql security definer set search_path = public as $$
declare
  s                shipments%rowtype;
  item             jsonb;
  v_item_id        uuid;
  v_expected       int;
  v_has_discrepancy bool;
  v_order          orders%rowtype;
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Not authorised';
  end if;

  select * into s from shipments where id = p_shipment_id;
  if not found then raise exception 'Shipment not found'; end if;
  if s.status <> 'arrived_bd' then
    raise exception 'Receiving check is only available when the shipment has arrived in Bangladesh';
  end if;

  if not exists (select 1 from orders where id = p_order_id and shipment_id = p_shipment_id) then
    raise exception 'Order not in this shipment';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    v_item_id := (item->>'order_item_id')::uuid;
    select quantity into v_expected
    from order_items where id = v_item_id and order_id = p_order_id;
    if not found then raise exception 'Item not found in order'; end if;

    insert into bd_received_items
      (shipment_id, order_id, order_item_id, expected_qty, received_qty, note, checked_by)
    values
      (p_shipment_id, p_order_id, v_item_id, v_expected,
       coalesce((item->>'received_qty')::int, v_expected),
       nullif(trim(coalesce(item->>'note', '')), ''),
       auth.uid())
    on conflict (shipment_id, order_item_id) do update set
      received_qty = excluded.received_qty,
      note         = excluded.note,
      checked_at   = now(),
      checked_by   = excluded.checked_by;
  end loop;

  -- Check for any remaining discrepancy across all items for this order
  select exists(
    select 1 from bd_received_items
    where shipment_id = p_shipment_id
      and order_id    = p_order_id
      and received_qty <> expected_qty
  ) into v_has_discrepancy;

  select * into v_order from orders where id = p_order_id for update;

  if v_has_discrepancy then
    -- Auto-hold if not already held or terminal
    if v_order.status <> 'hold' and not status_is_terminal(v_order.status) then
      perform _set_order_status(
        p_order_id, 'hold',
        'Hold due to discrepancy',
        'Receiving check found mismatched quantities in shipment ' || s.code
      );
    end if;
  else
    -- All quantities now match — lift the hold if it was placed by this check
    if v_order.status = 'hold' and v_order.previous_status is not null then
      perform _set_order_status(
        p_order_id, v_order.previous_status,
        'Hold lifted — discrepancy resolved in receiving check',
        null
      );
    end if;
  end if;
end $$;

-- Recreate view to expose order_status for the Discrepancies page badge
create or replace view bd_discrepancies with (security_invoker = true) as
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
  s.code        as shipment_code,
  o.order_number,
  o.status      as order_status,
  oi.product_name,
  oi.sku,
  oi.variant
from bd_received_items r
join shipments   s  on s.id  = r.shipment_id
join orders      o  on o.id  = r.order_id
join order_items oi on oi.id = r.order_item_id
where r.received_qty <> r.expected_qty;
