-- ---------------------------------------------------------------------
-- Partial Bangladesh-stock lines at hub receiving.
--
-- A brand can fulfil part of a line from its BD stock at dispatch
-- (order_items.inventory_qty, set by the brand portal's
-- create_inbound_batch). Those units never reach the Lahore hub, so the
-- hub counts only the Pakistan units (quantity - inventory_qty) and the
-- BD units are added on top, so the line isn't flagged short.
--
-- Mirrors the brand portal repo's 029_reconcile_dispatch_item_sources.sql,
-- but adds BD units only to the lines actually counted, so a recount can't
-- add them twice.
-- ---------------------------------------------------------------------

alter table order_items add column if not exists inventory_qty int not null default 0
  check (inventory_qty >= 0);

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
    update order_items set received_quantity = quantity
    where order_id = p_order_id and fulfilment_origin <> 'bangladesh';
  else
    -- received_quantity in p_items is the Pakistan units counted at the hub
    update order_items i set received_quantity = least(i.quantity,
      greatest(0, (x->>'received_quantity')::int)
      + case when i.fulfilment_origin <> 'bangladesh' then i.inventory_qty else 0 end)
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
                    || greatest(0, received_quantity - inventory_qty) || ' of '
                    || (quantity - inventory_qty) || ' from Pakistan', '; ')
  into v_short
  from order_items where order_id = p_order_id and received_quantity < quantity
    and fulfilment_origin <> 'bangladesh';

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

revoke all on function receive_order(uuid, numeric, jsonb, text) from public, anon;
grant execute on function receive_order(uuid, numeric, jsonb, text) to authenticated;
