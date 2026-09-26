-- =====================================================================
-- 041_accept_bd_stock_orders.sql
-- Orders whose every unit is fulfilled from the brand's Bangladesh stock
-- have nothing to count at the Lahore hub, and receive_order needs a
-- weight, so they were stuck at "Dispatched to hub" and could never reach
-- a shipment or the 50% advance invoice.
--
-- V360 now accepts them in Hub receiving: no count, no weight. They move to
-- ready_for_shipment and can be added to a shipment like any other order
-- (0 kg, so no shipping charge). Mixed orders keep using receive_order.
-- =====================================================================

create or replace function accept_bd_stock_order(p_order_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  if not is_v360() then raise exception 'Only V360 can accept orders at the hub'; end if;

  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('dispatched_to_hub', 'hub_issue') then
    raise exception 'Order % is "%" — it is not awaiting receipt', o.order_number, o.status;
  end if;
  if exists (select 1 from order_items i where i.order_id = p_order_id
             and order_item_hub_qty(i.quantity, i.inventory_qty, i.fulfilment_origin) > 0) then
    raise exception 'Order % has items coming from Pakistan — count them with Receive', o.order_number;
  end if;

  update orders set hub_notes = coalesce(nullif(trim(coalesce(p_note, '')), ''), hub_notes), received_at_hub_at = now()
  where id = p_order_id;

  perform _set_order_status(p_order_id, 'received_at_hub', 'Accepted at V360 hub',
    'Fulfilled from Bangladesh warehouse — nothing to count' || coalesce(' — ' || nullif(trim(coalesce(p_note, '')), ''), ''));
  perform _set_order_status(p_order_id, 'ready_for_shipment', 'Ready for shipment (Bangladesh stock)');

  -- Roll the parcel's status up (same as receive_order).
  if o.inbound_batch_id is not null then
    update inbound_batches b set
      status = case
        when exists (select 1 from orders x where x.inbound_batch_id = b.id and x.status = 'hub_issue') then 'issue'::inbound_status
        when not exists (select 1 from orders x where x.inbound_batch_id = b.id and x.status = 'dispatched_to_hub') then 'received'::inbound_status
        else b.status end,
      received_at = case
        when not exists (select 1 from orders x where x.inbound_batch_id = b.id and x.status = 'dispatched_to_hub')
        then coalesce(b.received_at, now()) else b.received_at end
    where b.id = o.inbound_batch_id;
  end if;
end $$;

revoke all on function accept_bd_stock_order(uuid, text) from public, anon;
grant execute on function accept_bd_stock_order(uuid, text) to authenticated;
