-- ---------------------------------------------------------------------
-- Fulfilment origin per order line item.
--
-- Some SKUs are fulfilled from a brand's local Bangladesh inventory and
-- never pass through the Lahore hub. The brand marks each line item's
-- origin when it dispatches a parcel. Hub receiving must only count the
-- quantity that the hub will actually receive (Pakistan-fulfilled SKUs);
-- quantities fulfilled from local BD inventory are excluded.
-- ---------------------------------------------------------------------

do $$ begin
  if to_regtype('public.fulfilment_origin') is null then
    execute 'create type public.fulfilment_origin as enum (''pakistan'', ''bangladesh'')';
  end if;
end $$;

alter table order_items
  add column if not exists fulfilment_origin fulfilment_origin not null default 'pakistan';

comment on column order_items.fulfilment_origin is
  'Where the SKU is fulfilled from at dispatch: pakistan (goes through the Lahore hub) or bangladesh (local BD inventory, never received at the hub).';

-- ---------------------------------------------------------------------
-- create_inbound_batch: optionally record each line item's origin.
-- p_item_sources is a jsonb array: [{"item_id": "...", "origin": "bangladesh"}, ...]
-- (the key is also accepted as "source" for compatibility with the brand
-- portal's existing dispatch function). Items not listed stay 'pakistan'.
-- ---------------------------------------------------------------------

drop function if exists create_inbound_batch(uuid[], text, text, date, text);
drop function if exists create_inbound_batch(uuid[], text, text, date, text, jsonb);

create function create_inbound_batch(
  p_order_ids uuid[], p_courier text, p_tracking_number text default null,
  p_dispatch_date date default current_date, p_notes text default null,
  p_item_sources jsonb default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_brand uuid;
  v_batch uuid;
  o record;
begin
  if coalesce(array_length(p_order_ids, 1), 0) = 0 then raise exception 'Select at least one order'; end if;
  if coalesce(trim(p_courier), '') = '' then raise exception 'Courier is required'; end if;

  select min(brand_id::text)::uuid into v_brand from orders where id = any(p_order_ids);
  if (select count(distinct brand_id) from orders where id = any(p_order_ids)) <> 1 then
    raise exception 'All orders in a dispatch must belong to the same brand';
  end if;
  if actor_group_for(v_brand) not in ('brand', 'v360') then raise exception 'You cannot dispatch these orders'; end if;

  for o in select * from orders where id = any(p_order_ids) for update loop
    if o.status not in ('confirmed', 'brand_preparing') then
      raise exception 'Order % is "%" — only confirmed orders can be dispatched', o.order_number, o.status;
    end if;
  end loop;

  insert into inbound_batches (brand_id, courier, tracking_number, dispatch_date, notes, created_by)
  values (v_brand, p_courier, nullif(trim(p_tracking_number), ''), p_dispatch_date, p_notes, auth.uid())
  returning id into v_batch;

  update orders set inbound_batch_id = v_batch where id = any(p_order_ids);

  if p_item_sources is not null then
    update order_items i set fulfilment_origin =
      case when lower(coalesce(x->>'origin', x->>'source', '')) = 'bangladesh' then 'bangladesh'::fulfilment_origin
           else 'pakistan'::fulfilment_origin end
    from jsonb_array_elements(p_item_sources) x
    where i.id = (x->>'item_id')::uuid
      and i.order_id = any(p_order_ids)
      and lower(coalesce(x->>'origin', x->>'source', '')) in ('pakistan', 'bangladesh');
  end if;

  for o in select id from orders where id = any(p_order_ids) loop
    perform _set_order_status(o.id, 'dispatched_to_hub', 'Dispatched to V360 hub',
      p_courier || coalesce(' — ' || nullif(trim(p_tracking_number), ''), ''));
  end loop;

  return v_batch;
end $$;

-- ---------------------------------------------------------------------
-- receive_order: BD-fulfilled items are never physically received at the
-- hub, so they never count toward a shortage and are never force-received.
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- Grants for the updated signatures
-- ---------------------------------------------------------------------

grant execute on function create_inbound_batch(uuid[], text, text, date, text, jsonb) to authenticated;
grant execute on function receive_order(uuid, numeric, jsonb, text) to authenticated;