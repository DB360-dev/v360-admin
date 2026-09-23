-- =====================================================================
-- 003_security.sql — Who can see and do what.
--   V360:  everything.
--   KBB:   all Bangladesh orders (read), shipments once dispatched,
--          and only the actions exposed by workflow functions.
--   Brand: only its own orders, dispatches, shipments containing them.
-- Reading = RLS policies. Writing = workflow functions (002).
-- =====================================================================

-- ---------- Table privileges ----------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on all tables in schema public to authenticated;

-- Direct writes allowed only where RLS below restricts them to V360
grant insert, update, delete on organizations, memberships, shopify_connections to authenticated;
grant insert, update on fx_rates to authenticated;
grant usage on sequence fx_rates_id_seq to authenticated;
grant update (full_name, phone) on profiles to authenticated;

-- Non-status shipment fields (status goes through set_shipment_status)
grant update (shipping_partner, tracking_number, total_weight_kg, origin, destination, notes)
  on shipments to authenticated;

-- Brand can fix its own courier details while a dispatch is in transit
grant update (courier, tracking_number, notes) on inbound_batches to authenticated;

-- Workflow engine needs to write these as the function owner; the
-- status guard trigger still applies.

-- ---------- Function privileges -------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  is_v360(), is_v360_admin(), is_partner(), my_brand_ids(), is_brand_member(uuid),
  actor_group_for(uuid), current_actor_label(),
  status_requires_dedicated_function(order_status), status_is_terminal(order_status),
  change_order_status(uuid, order_status, text),
  hold_order(uuid, text), resume_order(uuid, text),
  admin_override_status(uuid, order_status, text),
  brand_update_order(uuid, jsonb),
  create_inbound_batch(uuid[], text, text, date, text),
  receive_order(uuid, jsonb, text),
  create_shipment(text, text),
  add_orders_to_shipment(uuid, uuid[]),
  remove_order_from_shipment(uuid, text),
  set_shipment_status(uuid, shipment_status, text),
  set_delivery_tracking(uuid, text, text),
  mark_delivered(uuid, numeric, text),
  set_return_disposition(uuid, return_disposition, text),
  replay_webhook(text)
to authenticated;

-- Shopify ingestion: server-side only (Edge Functions use the service role)
grant execute on function
  ingest_shopify_order(uuid, jsonb), process_shopify_webhook(text, text, text, jsonb)
to service_role;

-- ---------- Enable RLS everywhere -----------------------------------

alter table organizations       enable row level security;
alter table profiles            enable row level security;
alter table memberships         enable row level security;
alter table shopify_connections enable row level security;
alter table webhook_events      enable row level security;
alter table inbound_batches     enable row level security;
alter table shipments           enable row level security;
alter table orders              enable row level security;
alter table order_items         enable row level security;
alter table order_events        enable row level security;
alter table shipment_events     enable row level security;
alter table fx_rates            enable row level security;
alter table status_transitions  enable row level security;

-- ---------- Organizations & people ----------------------------------

create policy org_read on organizations for select to authenticated
  using (is_v360() or is_partner()
         or id in (select organization_id from memberships where user_id = auth.uid()));
create policy org_write on organizations for all to authenticated
  using (is_v360_admin()) with check (is_v360_admin());

create policy profile_read on profiles for select to authenticated
  using (id = auth.uid() or is_v360());
create policy profile_update_self on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy membership_read on memberships for select to authenticated
  using (user_id = auth.uid() or is_v360());
create policy membership_write on memberships for all to authenticated
  using (is_v360_admin()) with check (is_v360_admin());

-- ---------- Shopify -------------------------------------------------

create policy shopify_read on shopify_connections for select to authenticated
  using (is_v360() or is_brand_member(brand_id));
create policy shopify_write on shopify_connections for all to authenticated
  using (is_v360()) with check (is_v360());

create policy webhook_read on webhook_events for select to authenticated
  using (is_v360());

-- ---------- Orders & children ---------------------------------------

create policy orders_read on orders for select to authenticated
  using (is_v360() or is_partner() or is_brand_member(brand_id));

create policy items_read on order_items for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id));

create policy events_read on order_events for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id));

-- ---------- Inbound batches (Brand -> hub) --------------------------

create policy inbound_read on inbound_batches for select to authenticated
  using (is_v360() or is_brand_member(brand_id));
create policy inbound_update on inbound_batches for update to authenticated
  using (is_v360() or (is_brand_member(brand_id) and status = 'in_transit'))
  with check (is_v360() or is_brand_member(brand_id));

-- ---------- Shipments (hub -> KBB) ----------------------------------

create policy shipments_read on shipments for select to authenticated
  using (
    is_v360()
    or (is_partner() and status >= 'handed_to_carrier')
    or exists (select 1 from orders o where o.shipment_id = shipments.id and is_brand_member(o.brand_id))
  );
create policy shipments_update on shipments for update to authenticated
  using (is_v360()) with check (is_v360());

create policy shipment_events_read on shipment_events for select to authenticated
  using (exists (select 1 from shipments s where s.id = shipment_id));

-- ---------- Reference data ------------------------------------------

create policy fx_read on fx_rates for select to authenticated using (true);
create policy fx_insert on fx_rates for insert to authenticated with check (is_v360());
create policy fx_update on fx_rates for update to authenticated using (is_v360()) with check (is_v360());

create policy transitions_read on status_transitions for select to authenticated using (true);

-- ---------- Auto-create profile on signup ---------------------------

create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

-- (Supabase's auth.users has raw_user_meta_data; the trigger is created
--  only if that column exists so this file also runs in local tests.)
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'auth' and table_name = 'users' and column_name = 'raw_user_meta_data') then
    create trigger on_auth_user_created after insert on auth.users
      for each row execute function handle_new_user();
  end if;
end $$;

-- ---------- Convenience view for list screens -----------------------
-- security_invoker = the caller's RLS applies, so it's safe for all portals.

create view order_overview with (security_invoker = true) as
select
  o.id, o.order_number, o.shopify_order_id, o.order_date, o.status, o.status_changed_at,
  o.brand_id, b.name as brand_name,
  o.customer_name, o.customer_phone, o.city, o.country_code,
  o.order_total, o.currency, o.cod_amount_expected, o.cod_amount_collected, o.cod_currency,
  o.confirmation_attempts,
  o.inbound_batch_id, ib.courier as inbound_courier, ib.tracking_number as inbound_tracking,
  o.shipment_id, s.code as shipment_code, s.tracking_number as shipment_tracking,
  s.shipping_partner, s.status as shipment_status,
  o.delivery_courier, o.delivery_tracking_number, o.delivered_at,
  (select coalesce(sum(quantity), 0) from order_items i where i.order_id = o.id) as item_count,
  now() - o.status_changed_at as time_in_status
from orders o
join organizations b on b.id = o.brand_id
left join inbound_batches ib on ib.id = o.inbound_batch_id
left join shipments s on s.id = o.shipment_id;

grant select on order_overview to authenticated;

-- ---------- Realtime -------------------------------------------------

alter publication supabase_realtime add table orders, order_events, shipments;
