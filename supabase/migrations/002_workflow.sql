-- =====================================================================
-- 002_workflow.sql — Status machine + every action the portals can take.
--
-- RULE: the frontend NEVER updates orders.status directly. It calls these
-- functions with supabase.rpc('function_name', {...}). A trigger blocks
-- any status change that doesn't come through here.
-- =====================================================================

-- ---------- Who is calling? -----------------------------------------

create function is_v360() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'v360' and o.is_active
  )
$$;

create function is_v360_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'v360' and m.role = 'admin' and o.is_active
  )
$$;

create function is_partner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'partner' and o.is_active
  )
$$;

create function my_brand_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select o.id from memberships m join organizations o on o.id = m.organization_id
  where m.user_id = auth.uid() and o.type = 'brand' and o.is_active
$$;

create function is_brand_member(p_brand_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_brand_id in (select my_brand_ids())
$$;

-- 'v360' | 'partner' | 'brand' | null — for one specific order's brand
create function actor_group_for(p_brand_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when is_v360() then 'v360'
    when is_partner() then 'partner'
    when is_brand_member(p_brand_id) then 'brand'
    else null end
$$;

create function current_actor_label() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select o.name from memberships m join organizations o on o.id = m.organization_id
      where m.user_id = auth.uid()
      order by case o.type when 'v360' then 1 when 'partner' then 2 else 3 end limit 1),
    'System')
$$;

-- ---------- Allowed transitions -------------------------------------
-- actor: who may make this move. V360 may make ANY listed move.
-- Moves that need extra data (dispatch, receiving, shipments, delivery)
-- are done by dedicated functions below, not change_order_status().

create table status_transitions (
  from_status  order_status not null,
  to_status    order_status not null,
  actor        text not null check (actor in ('partner', 'brand', 'v360')),
  primary key (from_status, to_status, actor)
);

insert into status_transitions (from_status, to_status, actor) values
  -- KBB confirmation calls
  ('new',                  'confirmation_pending', 'partner'),
  ('new',                  'confirmed',            'partner'),
  ('new',                  'customer_unreachable', 'partner'),
  ('new',                  'needs_amendment',      'partner'),
  ('new',                  'cancelled',            'partner'),
  ('confirmation_pending', 'confirmed',            'partner'),
  ('confirmation_pending', 'customer_unreachable', 'partner'),
  ('confirmation_pending', 'needs_amendment',      'partner'),
  ('confirmation_pending', 'cancelled',            'partner'),
  ('customer_unreachable', 'confirmation_pending', 'partner'),
  ('customer_unreachable', 'confirmed',            'partner'),
  ('customer_unreachable', 'customer_unreachable', 'partner'),  -- another failed attempt
  ('customer_unreachable', 'needs_amendment',      'partner'),
  ('customer_unreachable', 'cancelled',            'partner'),
  ('needs_amendment',      'cancelled',            'partner'),

  -- Brand can cancel before it ships to the hub
  ('new',                  'cancelled',            'brand'),
  ('confirmation_pending', 'cancelled',            'brand'),
  ('customer_unreachable', 'cancelled',            'brand'),
  ('needs_amendment',      'cancelled',            'brand'),
  ('confirmed',            'cancelled',            'brand'),
  ('brand_preparing',      'cancelled',            'brand'),

  -- Brand preparation
  ('confirmed',            'brand_preparing',      'brand'),

  -- Bangladesh last mile (KBB)
  ('received_by_partner',    'preparing_for_delivery', 'partner'),
  ('received_by_partner',    'out_for_delivery',       'partner'),
  ('preparing_for_delivery', 'out_for_delivery',       'partner'),
  ('out_for_delivery',       'delivery_failed',        'partner'),
  ('delivery_failed',        'out_for_delivery',       'partner'),
  ('delivery_failed',        'returned',               'partner'),

  -- V360-only
  ('received_at_hub',      'ready_for_shipment',   'v360'),
  ('hub_issue',            'cancelled',            'v360');

-- Statuses that ONLY dedicated functions may set.
create function status_requires_dedicated_function(s order_status) returns boolean
language sql immutable as $$
  select s in ('dispatched_to_hub', 'received_at_hub', 'hub_issue', 'assigned_to_shipment',
               'shipped', 'in_transit', 'customs', 'arrived_bd', 'received_by_partner',
               'delivered', 'hold')
$$;

create function status_is_terminal(s order_status) returns boolean
language sql immutable as $$ select s in ('delivered', 'cancelled', 'returned') $$;

-- ---------- Guard: block status edits outside these functions --------

create function guard_order_status() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status
     and coalesce(current_setting('app.status_change', true), '') <> 'on' then
    raise exception 'Order status can only be changed through workflow functions (e.g. change_order_status).';
  end if;
  return new;
end $$;

create trigger orders_guard_status before update on orders
  for each row execute function guard_order_status();

-- ---------- Internal setter: the ONLY place status is written --------

create function _set_order_status(
  p_order_id uuid, p_to order_status, p_action text, p_note text default null, p_actor_label text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_from order_status;
begin
  select status into v_from from orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;

  perform set_config('app.status_change', 'on', true);

  update orders set
    status            = p_to,
    status_changed_at = now(),
    previous_status   = case when p_to = 'hold' then v_from
                             when v_from = 'hold' then null
                             else previous_status end,
    confirmation_attempts = confirmation_attempts
                            + case when p_to = 'customer_unreachable' then 1 else 0 end,
    confirmed_at      = case when p_to = 'confirmed' then now() else confirmed_at end,
    confirmed_by      = case when p_to = 'confirmed' then auth.uid() else confirmed_by end
  where id = p_order_id;

  perform set_config('app.status_change', 'off', true);

  insert into order_events (order_id, actor_id, actor_label, action, from_status, to_status, note)
  values (p_order_id, auth.uid(), coalesce(p_actor_label, current_actor_label()), p_action, v_from, p_to, p_note);
end $$;

create function _log_order_event(p_order_id uuid, p_action text, p_note text default null, p_actor_label text default null)
returns void language sql security definer set search_path = public as $$
  insert into order_events (order_id, actor_id, actor_label, action, note)
  values (p_order_id, auth.uid(), coalesce(p_actor_label, current_actor_label()), p_action, p_note)
$$;

-- ---------- Generic status change (portals call this) ----------------

create function change_order_status(p_order_id uuid, p_to order_status, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  v_actor text;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;

  v_actor := actor_group_for(o.brand_id);
  if v_actor is null then raise exception 'You do not have access to this order'; end if;

  if status_requires_dedicated_function(p_to) then
    raise exception 'Status "%" is set by its own action, not change_order_status', p_to;
  end if;

  if p_to in ('cancelled', 'delivery_failed', 'needs_amendment') and coalesce(trim(p_note), '') = '' then
    raise exception 'A reason is required when marking an order as %', p_to;
  end if;

  if not exists (
    select 1 from status_transitions t
    where t.from_status = o.status and t.to_status = p_to
      and (t.actor = v_actor or v_actor = 'v360')
  ) then
    raise exception 'Cannot move order % from "%" to "%"', o.order_number, o.status, p_to;
  end if;

  if p_to = 'delivery_failed' then
    update orders set failure_reason = p_note where id = p_order_id;
  end if;
  if p_to = 'returned' then
    update orders set return_disposition = 'pending' where id = p_order_id;
  end if;

  perform _set_order_status(p_order_id, p_to, 'Status changed', p_note);
end $$;

-- ---------- Hold / resume (V360 or KBB) -----------------------------

create function hold_order(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if not (is_v360() or is_partner()) then raise exception 'Only V360 or the fulfilment partner can hold orders'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if o.status = 'hold' or status_is_terminal(o.status) then
    raise exception 'Order % cannot be put on hold from "%"', o.order_number, o.status;
  end if;
  perform _set_order_status(p_order_id, 'hold', 'Put on hold', p_reason);
end $$;

create function resume_order(p_order_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if not (is_v360() or is_partner()) then raise exception 'Only V360 or the fulfilment partner can resume orders'; end if;
  if o.status <> 'hold' or o.previous_status is null then raise exception 'Order is not on hold'; end if;
  perform _set_order_status(p_order_id, o.previous_status, 'Resumed from hold', p_note);
end $$;

-- ---------- V360 override (bypasses the rules, always logged) --------

create function admin_override_status(p_order_id uuid, p_to order_status, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_v360() then raise exception 'Only V360 can override statuses'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required for overrides'; end if;
  perform _set_order_status(p_order_id, p_to, 'Status overridden by V360', p_reason);
end $$;

-- ---------- Brand edits permitted order details ----------------------

create function brand_update_order(p_order_id uuid, p_changes jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  v_actor text;
  k text;
  allowed text[] := array['customer_name','customer_phone','customer_email','address1','address2',
                          'city','province','zip','customer_note'];
  reconfirm_fields text[] := array['customer_phone','address1','address2','city','province','zip'];
  v_changed text[] := '{}';
  v_needs_reconfirm boolean := false;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  v_actor := actor_group_for(o.brand_id);
  if v_actor not in ('brand', 'v360') then raise exception 'You cannot edit this order'; end if;

  if o.status not in ('new','confirmation_pending','customer_unreachable','needs_amendment','confirmed','brand_preparing') then
    raise exception 'Order % can no longer be edited (status "%")', o.order_number, o.status;
  end if;

  for k in select jsonb_object_keys(p_changes) loop
    if not k = any(allowed) then raise exception 'Field "%" cannot be edited', k; end if;
  end loop;

  update orders set
    customer_name  = coalesce(p_changes->>'customer_name',  customer_name),
    customer_phone = coalesce(p_changes->>'customer_phone', customer_phone),
    customer_email = coalesce(p_changes->>'customer_email', customer_email),
    address1       = coalesce(p_changes->>'address1',       address1),
    address2       = coalesce(p_changes->>'address2',       address2),
    city           = coalesce(p_changes->>'city',           city),
    province       = coalesce(p_changes->>'province',       province),
    zip            = coalesce(p_changes->>'zip',            zip),
    customer_note  = coalesce(p_changes->>'customer_note',  customer_note)
  where id = p_order_id;

  select array_agg(key) into v_changed from jsonb_each_text(p_changes) e
  where e.value is distinct from (to_jsonb(o) ->> e.key);

  if v_changed is null then return; end if;

  perform _log_order_event(p_order_id, 'Order details edited', 'Changed: ' || array_to_string(v_changed, ', '));

  v_needs_reconfirm := v_changed && reconfirm_fields;
  if o.status = 'needs_amendment'
     or (v_needs_reconfirm and o.status in ('confirmed', 'brand_preparing')) then
    perform _set_order_status(p_order_id, 'confirmation_pending',
      'Sent back for confirmation', 'Contact or address details changed');
  end if;
end $$;

-- ---------- Brand dispatches orders to the V360 hub ------------------

create function create_inbound_batch(
  p_order_ids uuid[], p_courier text, p_tracking_number text default null,
  p_dispatch_date date default current_date, p_notes text default null
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

  for o in select id from orders where id = any(p_order_ids) loop
    perform _set_order_status(o.id, 'dispatched_to_hub', 'Dispatched to V360 hub',
      p_courier || coalesce(' — ' || nullif(trim(p_tracking_number), ''), ''));
  end loop;

  return v_batch;
end $$;

-- ---------- V360 receives an order at the hub ------------------------
-- p_items: [{"item_id": "...", "received_quantity": 2}, ...]
-- Pass null to mark every item as fully received.

create function receive_order(p_order_id uuid, p_items jsonb default null, p_note text default null)
returns order_status
language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  v_short text;
  v_result order_status;
begin
  if not is_v360() then raise exception 'Only V360 can receive orders at the hub'; end if;
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

-- ---------- Consolidated shipments (V360) ----------------------------

create function create_shipment(p_shipping_partner text default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_v360() then raise exception 'Only V360 can create shipments'; end if;
  insert into shipments (shipping_partner, notes, created_by)
  values (p_shipping_partner, p_notes, auth.uid()) returning id into v_id;
  insert into shipment_events (shipment_id, actor_id, action, to_status)
  values (v_id, auth.uid(), 'Shipment created', 'draft');
  return v_id;
end $$;

create function add_orders_to_shipment(p_shipment_id uuid, p_order_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  s shipments%rowtype;
  o record;
begin
  if not is_v360() then raise exception 'Only V360 can build shipments'; end if;
  select * into s from shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment not found'; end if;
  if s.status not in ('draft', 'ready_for_dispatch') then
    raise exception 'Shipment % has already been dispatched', s.code;
  end if;

  for o in select * from orders where id = any(p_order_ids) for update loop
    if o.status <> 'ready_for_shipment' then
      raise exception 'Order % is "%" — only orders that are ready for shipment can be added', o.order_number, o.status;
    end if;
  end loop;

  update orders set shipment_id = p_shipment_id where id = any(p_order_ids);
  for o in select id from orders where id = any(p_order_ids) loop
    perform _set_order_status(o.id, 'assigned_to_shipment', 'Added to shipment ' || s.code);
  end loop;

  insert into shipment_events (shipment_id, actor_id, action, note)
  values (p_shipment_id, auth.uid(), 'Orders added', array_length(p_order_ids, 1) || ' order(s)');
end $$;

create function remove_order_from_shipment(p_order_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  s shipments%rowtype;
begin
  if not is_v360() then raise exception 'Only V360 can edit shipments'; end if;
  select * into o from orders where id = p_order_id for update;
  if o.shipment_id is null then raise exception 'Order is not in a shipment'; end if;
  select * into s from shipments where id = o.shipment_id for update;
  if s.status not in ('draft', 'ready_for_dispatch') then
    raise exception 'Shipment % has already been dispatched', s.code;
  end if;
  update orders set shipment_id = null where id = p_order_id;
  perform _set_order_status(p_order_id, 'ready_for_shipment', 'Removed from shipment ' || s.code, p_note);
  insert into shipment_events (shipment_id, actor_id, action, note)
  values (s.id, auth.uid(), 'Order removed', o.order_number || coalesce(' — ' || p_note, ''));
end $$;

-- Shipment status moves forward only; orders inside follow automatically.
create function set_shipment_status(p_shipment_id uuid, p_to shipment_status, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  s shipments%rowtype;
  v_order_status order_status;
  o record;
begin
  select * into s from shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment not found'; end if;

  if is_v360() then
    null;
  elsif is_partner() and p_to = 'received_by_partner' then
    null;
  else
    raise exception 'You cannot change this shipment''s status';
  end if;

  if p_to <= s.status then
    raise exception 'Shipment % is already "%" — status can only move forward', s.code, s.status;
  end if;

  if p_to >= 'ready_for_dispatch' and not exists (select 1 from orders where shipment_id = s.id) then
    raise exception 'Shipment % has no orders', s.code;
  end if;
  if p_to >= 'handed_to_carrier' and (s.tracking_number is null or s.shipping_partner is null) then
    raise exception 'Add the shipping partner and tracking ID before dispatching %', s.code;
  end if;
  if p_to = 'received_by_partner' and s.status < 'handed_to_carrier' then
    raise exception 'Shipment % has not been dispatched yet', s.code;
  end if;

  update shipments set
    status        = p_to,
    dispatched_at = case when p_to >= 'handed_to_carrier' then coalesce(dispatched_at, now()) else dispatched_at end,
    received_at   = case when p_to = 'received_by_partner' then now() else received_at end
  where id = p_shipment_id;

  insert into shipment_events (shipment_id, actor_id, action, from_status, to_status, note)
  values (p_shipment_id, auth.uid(), 'Status changed', s.status, p_to, p_note);

  v_order_status := case p_to
    when 'handed_to_carrier'   then 'shipped'
    when 'in_transit'          then 'in_transit'
    when 'customs'             then 'customs'
    when 'arrived_bd'          then 'arrived_bd'
    when 'received_by_partner' then 'received_by_partner'
    else null end;

  if v_order_status is not null then
    -- Orders on hold or cancelled keep their status; everything in flight follows.
    for o in select id from orders
             where shipment_id = p_shipment_id
               and status in ('assigned_to_shipment','shipped','in_transit','customs','arrived_bd')
    loop
      perform _set_order_status(o.id, v_order_status, 'Shipment ' || s.code || ' updated', p_note);
    end loop;
  end if;
end $$;

-- ---------- KBB last mile --------------------------------------------

create function set_delivery_tracking(p_order_id uuid, p_courier text, p_tracking_number text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_v360() or is_partner()) then raise exception 'Not allowed'; end if;
  update orders set delivery_courier = p_courier, delivery_tracking_number = p_tracking_number
  where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
  perform _log_order_event(p_order_id, 'Delivery tracking added', p_courier || ' — ' || p_tracking_number);
end $$;

create function mark_delivered(p_order_id uuid, p_cod_collected numeric, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  if not (is_v360() or is_partner()) then raise exception 'Not allowed'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'out_for_delivery' then
    raise exception 'Order % is "%" — only orders out for delivery can be marked delivered', o.order_number, o.status;
  end if;
  if p_cod_collected is null or p_cod_collected < 0 then
    raise exception 'Enter the cash collected (0 if prepaid)';
  end if;

  update orders set cod_amount_collected = p_cod_collected,
                    cod_currency = coalesce(cod_currency, 'BDT'),
                    delivered_at = now()
  where id = p_order_id;

  perform _set_order_status(p_order_id, 'delivered', 'Delivered',
    'Collected ' || p_cod_collected || ' ' || coalesce(o.cod_currency, 'BDT')
    || case when o.cod_amount_expected is not null and p_cod_collected <> o.cod_amount_expected
            then ' (expected ' || o.cod_amount_expected || ')' else '' end
    || coalesce(' — ' || p_note, ''));
end $$;

create function set_return_disposition(p_order_id uuid, p_disposition return_disposition, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_v360() then raise exception 'Only V360 can decide what happens to returns'; end if;
  update orders set return_disposition = p_disposition where id = p_order_id and status = 'returned';
  if not found then raise exception 'Order is not in returned status'; end if;
  perform _log_order_event(p_order_id, 'Return disposition: ' || p_disposition, p_note);
end $$;

-- ---------- Shopify ingestion (called by the Edge Function only) -----

create function ingest_shopify_order(p_brand_id uuid, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sa jsonb := p_payload->'shipping_address';
  v_country text := upper(coalesce(sa->>'country_code', ''));
  v_shopify_id bigint := (p_payload->>'id')::bigint;
  v_hash text;
  v_existing orders%rowtype;
  v_order_id uuid;
  v_financial text := p_payload->>'financial_status';
  v_presentment_total numeric := coalesce(
      (p_payload#>>'{total_price_set,presentment_money,amount}')::numeric,
      (p_payload->>'total_price')::numeric);
  v_presentment_currency text := coalesce(
      p_payload#>>'{total_price_set,presentment_money,currency_code}',
      p_payload->>'presentment_currency', p_payload->>'currency');
  v_notes text;
begin
  if v_country <> 'BD' then
    return jsonb_build_object('action', 'skipped', 'reason', 'country ' || coalesce(nullif(v_country, ''), 'missing'));
  end if;

  -- Fingerprint of the fields we care about, to ignore no-op webhooks.
  v_hash := md5(concat_ws('|', sa::text, p_payload->>'total_price', p_payload->>'financial_status',
                          p_payload->>'cancelled_at', p_payload->>'note', (p_payload->'line_items')::text));

  select string_agg((a->>'name') || ': ' || (a->>'value'), E'\n') into v_notes
  from jsonb_array_elements(coalesce(p_payload->'note_attributes', '[]'::jsonb)) a;

  select * into v_existing from orders
  where brand_id = p_brand_id and shopify_order_id = v_shopify_id for update;

  if not found then
    insert into orders (
      brand_id, shopify_order_id, order_number, order_date,
      customer_name, customer_phone, customer_email,
      address1, address2, city, province, zip, country_code,
      currency, subtotal, discount_total, shipping_total, order_total, payment_status,
      cod_amount_expected, cod_currency, customer_note, shopify_note, shopify_payload_hash
    ) values (
      p_brand_id, v_shopify_id, coalesce(p_payload->>'name', '#' || (p_payload->>'order_number')),
      coalesce((p_payload->>'created_at')::timestamptz, now()),
      coalesce(sa->>'name', trim(concat_ws(' ', sa->>'first_name', sa->>'last_name'))),
      coalesce(sa->>'phone', p_payload->>'phone', p_payload#>>'{customer,phone}'),
      coalesce(p_payload->>'email', p_payload#>>'{customer,email}'),
      sa->>'address1', sa->>'address2', sa->>'city', sa->>'province', sa->>'zip', v_country,
      coalesce(p_payload->>'currency', 'PKR'),
      coalesce((p_payload->>'subtotal_price')::numeric, 0),
      coalesce((p_payload->>'total_discounts')::numeric, 0),
      coalesce((p_payload#>>'{total_shipping_price_set,shop_money,amount}')::numeric, 0),
      coalesce((p_payload->>'total_price')::numeric, 0),
      v_financial,
      case when v_financial in ('paid', 'refunded') then 0 else v_presentment_total end,
      v_presentment_currency,
      p_payload->>'note', v_notes, v_hash
    ) returning id into v_order_id;

    insert into order_items (order_id, shopify_line_item_id, product_name, sku, variant, quantity, unit_price, discount)
    select v_order_id, (li->>'id')::bigint, coalesce(li->>'title', li->>'name'), nullif(li->>'sku', ''),
           nullif(li->>'variant_title', ''), (li->>'quantity')::int,
           coalesce((li->>'price')::numeric, 0), coalesce((li->>'total_discount')::numeric, 0)
    from jsonb_array_elements(coalesce(p_payload->'line_items', '[]'::jsonb)) li
    where (li->>'quantity')::int > 0;

    insert into order_events (order_id, actor_label, action, to_status)
    values (v_order_id, 'Shopify', 'Imported from Shopify', 'new');

    -- An order can arrive already cancelled (e.g. replayed webhook)
    if p_payload->>'cancelled_at' is not null then
      update orders set shopify_cancelled_at = (p_payload->>'cancelled_at')::timestamptz where id = v_order_id;
      perform _set_order_status(v_order_id, 'cancelled', 'Cancelled in Shopify', null, 'Shopify');
    end if;
    return jsonb_build_object('action', 'created', 'order_id', v_order_id);
  end if;

  v_order_id := v_existing.id;

  if v_existing.shopify_payload_hash = v_hash then
    return jsonb_build_object('action', 'unchanged', 'order_id', v_order_id);
  end if;

  update orders set shopify_payload_hash = v_hash, payment_status = v_financial where id = v_order_id;

  -- Cancellation in Shopify
  if p_payload->>'cancelled_at' is not null and v_existing.shopify_cancelled_at is null then
    update orders set shopify_cancelled_at = (p_payload->>'cancelled_at')::timestamptz where id = v_order_id;
    if v_existing.status in ('new','confirmation_pending','customer_unreachable','needs_amendment','confirmed','brand_preparing') then
      perform _set_order_status(v_order_id, 'cancelled', 'Cancelled in Shopify', null, 'Shopify');
    elsif not status_is_terminal(v_existing.status) and v_existing.status <> 'hold' then
      perform _set_order_status(v_order_id, 'hold', 'Cancelled in Shopify after dispatch',
        'V360 to decide: stop, return, or deliver anyway', 'Shopify');
    else
      perform _log_order_event(v_order_id, 'Cancelled in Shopify', 'Order was already ' || v_existing.status, 'Shopify');
    end if;
    return jsonb_build_object('action', 'cancelled', 'order_id', v_order_id);
  end if;

  -- Edits: apply only while the order hasn't been confirmed yet.
  if v_existing.status in ('new','confirmation_pending','customer_unreachable','needs_amendment') then
    update orders set
      customer_name  = coalesce(sa->>'name', customer_name),
      customer_phone = coalesce(sa->>'phone', p_payload->>'phone', customer_phone),
      customer_email = coalesce(p_payload->>'email', customer_email),
      address1 = sa->>'address1', address2 = sa->>'address2', city = sa->>'city',
      province = sa->>'province', zip = sa->>'zip',
      subtotal = coalesce((p_payload->>'subtotal_price')::numeric, subtotal),
      discount_total = coalesce((p_payload->>'total_discounts')::numeric, discount_total),
      order_total = coalesce((p_payload->>'total_price')::numeric, order_total),
      cod_amount_expected = case when v_financial in ('paid','refunded') then 0 else v_presentment_total end,
      customer_note = p_payload->>'note', shopify_note = v_notes
    where id = v_order_id;

    insert into order_items (order_id, shopify_line_item_id, product_name, sku, variant, quantity, unit_price, discount)
    select v_order_id, (li->>'id')::bigint, coalesce(li->>'title', li->>'name'), nullif(li->>'sku', ''),
           nullif(li->>'variant_title', ''), (li->>'quantity')::int,
           coalesce((li->>'price')::numeric, 0), coalesce((li->>'total_discount')::numeric, 0)
    from jsonb_array_elements(coalesce(p_payload->'line_items', '[]'::jsonb)) li
    where (li->>'quantity')::int > 0
    on conflict (order_id, shopify_line_item_id) do update set
      product_name = excluded.product_name, sku = excluded.sku, variant = excluded.variant,
      quantity = excluded.quantity, unit_price = excluded.unit_price, discount = excluded.discount;

    delete from order_items i where i.order_id = v_order_id
      and i.shopify_line_item_id not in (
        select (li->>'id')::bigint from jsonb_array_elements(coalesce(p_payload->'line_items','[]'::jsonb)) li
        where (li->>'quantity')::int > 0);

    perform _log_order_event(v_order_id, 'Updated from Shopify', null, 'Shopify');
    return jsonb_build_object('action', 'updated', 'order_id', v_order_id);
  end if;

  perform _log_order_event(v_order_id, 'Order changed in Shopify after confirmation — not applied',
    'Check the Shopify order and edit here if needed', 'Shopify');
  return jsonb_build_object('action', 'flagged', 'order_id', v_order_id);
end $$;

-- Entry point for the webhook Edge Function: idempotent by webhook id.
create function process_shopify_webhook(p_webhook_id text, p_topic text, p_shop_domain text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_brand uuid;
  v_result jsonb;
begin
  insert into webhook_events (webhook_id, topic, shop_domain, payload)
  values (p_webhook_id, p_topic, p_shop_domain, p_payload)
  on conflict (webhook_id) do nothing;
  if not found then return jsonb_build_object('action', 'duplicate'); end if;

  select brand_id into v_brand from shopify_connections where shop_domain = p_shop_domain;
  if v_brand is null then
    update webhook_events set error = 'Unknown shop' where webhook_id = p_webhook_id;
    return jsonb_build_object('action', 'error', 'reason', 'unknown shop ' || p_shop_domain);
  end if;

  begin
    if p_topic = 'app/uninstalled' then
      update shopify_connections set status = 'uninstalled' where brand_id = v_brand;
      v_result := jsonb_build_object('action', 'uninstalled');
    elsif p_topic in ('orders/create', 'orders/updated', 'orders/cancelled', 'orders/paid') then
      v_result := ingest_shopify_order(v_brand, p_payload);
      update shopify_connections set last_synced_at = now() where brand_id = v_brand;
    else
      v_result := jsonb_build_object('action', 'ignored', 'topic', p_topic);
    end if;
  exception when others then
    -- Order changes roll back; the raw webhook stays logged with its error for replay.
    update webhook_events set error = sqlerrm where webhook_id = p_webhook_id;
    return jsonb_build_object('action', 'error', 'reason', sqlerrm);
  end;

  update webhook_events set processed_at = now(), error = null where webhook_id = p_webhook_id;
  return v_result;
end $$;

-- V360 can re-run a failed webhook after fixing the cause.
create function replay_webhook(p_webhook_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w webhook_events%rowtype;
begin
  if not is_v360() then raise exception 'Only V360 can replay webhooks'; end if;
  select * into w from webhook_events where webhook_id = p_webhook_id;
  if not found then raise exception 'Webhook not found'; end if;
  delete from webhook_events where webhook_id = p_webhook_id;
  return process_shopify_webhook(w.webhook_id, w.topic, w.shop_domain, w.payload);
end $$;
