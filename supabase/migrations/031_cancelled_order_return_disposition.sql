-- Cancelled orders whose goods the brand had already dispatched get the same
-- "Decide on return" step as returned orders. Allowed decisions depend on where the goods are:
--   * cancelled before the shipment left Pakistan: return to brand / write off
--   * otherwise (in or past transit to BD): restock in BD / return to PK / write off

create or replace function set_return_disposition(
  p_order_id uuid,
  p_items    jsonb,   -- [{order_item_id: uuid, disposition: return_disposition}]
  p_note     text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_in_pk  boolean;
  item     jsonb;
  v_item   uuid;
  v_disp   return_disposition;
  v_summary return_disposition;
begin
  if not is_v360() then raise exception 'Only V360 can decide what happens to returns'; end if;

  if not exists (select 1 from orders where id = p_order_id
                 and (status = 'returned' or (status = 'cancelled' and inbound_batch_id is not null))) then
    raise exception 'Only returned orders, or cancelled orders the brand already dispatched, can have a return decision';
  end if;

  -- Goods are still in Pakistan if the order is cancelled and its shipment
  -- (if any) hasn't been handed to the carrier yet.
  select o.status = 'cancelled'
         and coalesce(sh.status in ('draft', 'ready_for_dispatch'), true)
    into v_in_pk
  from orders o left join shipments sh on sh.id = o.shipment_id
  where o.id = p_order_id;

  for item in select * from jsonb_array_elements(p_items) loop
    v_item := (item->>'order_item_id')::uuid;
    v_disp := (item->>'disposition')::return_disposition;

    if v_in_pk and v_disp not in ('return_to_brand', 'written_off') then
      raise exception 'This order never left Pakistan: return its goods to the brand or write them off';
    elsif not v_in_pk and v_disp = 'return_to_brand' then
      raise exception 'Return to brand is only for orders cancelled before shipping to Bangladesh';
    end if;

    update order_items
    set return_disposition = v_disp
    where id = v_item and order_id = p_order_id;

    if not found then raise exception 'Item % not found in order', v_item; end if;
  end loop;

  -- Derive order-level summary: most frequent item disposition
  select return_disposition into v_summary
  from order_items
  where order_id = p_order_id and return_disposition is not null
  group by return_disposition
  order by count(*) desc
  limit 1;

  if v_summary is not null then
    update orders set return_disposition = v_summary where id = p_order_id;
  end if;

  perform _log_order_event(p_order_id, 'Return disposition saved', p_note);
end $$;

-- No change to bd_restocked_items: the live view filters only on
-- return_disposition = 'restock_in_bd' (no order-status filter), so restocked
-- items from cancelled orders already show up.
