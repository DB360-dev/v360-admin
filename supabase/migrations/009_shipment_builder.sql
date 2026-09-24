-- =====================================================================
-- Order-driven shipment creation (V360 ship-builder on the Shipments page)
-- Creates a draft shipment and attaches the selected orders in one call.
-- =====================================================================

create function create_shipment_with_orders(
  p_order_ids        uuid[],
  p_shipping_partner text default null,
  p_notes            text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  o record;
begin
  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    raise exception 'Choose at least one order';
  end if;
  if not is_v360() then raise exception 'Only V360 can create shipments'; end if;

  for o in select * from orders where id = any(p_order_ids) for update loop
    if o.shipment_id is not null then
      raise exception 'Order % is already in a shipment', o.order_number;
    end if;
    if o.status <> 'ready_for_shipment' then
      raise exception 'Order % is "%" — only orders ready for shipment can be shipped', o.order_number, o.status;
    end if;
  end loop;

  insert into shipments (shipping_partner, notes, created_by)
  values (p_shipping_partner, p_notes, auth.uid()) returning id into v_id;

  update orders set shipment_id = v_id where id = any(p_order_ids);
  for o in select id from orders where id = any(p_order_ids) loop
    perform _set_order_status(o.id, 'assigned_to_shipment', 'Added to shipment (built from orders)');
  end loop;

  insert into shipment_events (shipment_id, actor_id, action, to_status, note)
  values (v_id, auth.uid(), 'Shipment created', 'draft',
          array_length(p_order_ids, 1) || ' order(s) added');

  return v_id;
end $$;

revoke execute on function create_shipment_with_orders(uuid[], text, text) from public;
grant execute on function create_shipment_with_orders(uuid[], text, text) to authenticated;