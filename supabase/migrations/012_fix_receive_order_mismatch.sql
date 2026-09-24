-- Fix receive_order function so orders with all items received after recount transition back to ready_for_shipment.
--
-- Previously, string_agg in receive_order queried order_items without "and received_quantity < quantity".
-- As a result, v_short was never null even when all items were received, causing orders to stay in 'hub_issue' status forever.

create or replace function receive_order(
  p_order_id        uuid,
  p_order_weight_kg numeric,
  p_items           jsonb default null,
  p_note            text  default null
)
returns order_status
language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  v_short text;
  v_result order_status;
  v_rate numeric := (select freight_bdt_per_kg from money_settings where id = 1);
begin
  if not is_v360() then raise exception 'Only V360 can receive orders at the hub'; end if;
  if p_order_weight_kg is null or p_order_weight_kg <= 0 then
    raise exception 'Enter the weight of every item before receiving';
  end if;
  if v_rate is null then
    raise exception 'Set the BDT freight rate per kg in Money settings first';
  end if;

  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('dispatched_to_hub', 'hub_issue') then
    raise exception 'Order % is "%" — it is not awaiting receipt', o.order_number, o.status;
  end if;

  if p_items is null then
    update order_items set received_quantity = quantity where order_id = p_order_id;
  else
    update order_items i set received_quantity = (x->>'received_quantity')::int
    from jsonb_array_elements(p_items) x
    where i.id = (x->>'item_id')::uuid and i.order_id = p_order_id;
  end if;

  insert into order_freight_weights (order_id, weight_kg, freight_bdt_per_kg, fx_rate, fx_rate_date, updated_at)
  values (p_order_id, p_order_weight_kg, v_rate, fx_rate_pkr('BDT', current_date), current_date, now())
  on conflict (order_id) do update set
    weight_kg          = excluded.weight_kg,
    freight_bdt_per_kg = excluded.freight_bdt_per_kg,
    fx_rate            = excluded.fx_rate,
    fx_rate_date       = excluded.fx_rate_date,
    updated_at         = now();

  select string_agg(product_name || coalesce(' (' || variant || ')', '') || ': '
                    || received_quantity || ' of ' || quantity, '; ')
  into v_short
  from order_items where order_id = p_order_id and received_quantity < quantity;

  update orders set hub_notes = coalesce(p_note, hub_notes), received_at_hub_at = now() where id = p_order_id;

  if v_short is null then
    perform _set_order_status(p_order_id, 'received_at_hub', 'Received at V360 hub', p_note);
    perform _set_order_status(p_order_id, 'ready_for_shipment', 'All items received — ready for shipment');
    v_result := 'ready_for_shipment';
  else
    if o.status <> 'hub_issue' then
      perform _set_order_status(p_order_id, 'hub_issue', 'Receiving mismatch', 'Short: ' || v_short
        || coalesce(' — ' || p_note, ''));
    else
      perform _log_order_event(p_order_id, 'Receiving re-checked, still short', 'Short: ' || v_short);
    end if;
    v_result := 'hub_issue';
  end if;

  -- Roll the batch status up
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

  return v_result;
end $$;
