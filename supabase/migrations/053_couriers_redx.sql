-- =====================================================================
-- 053_couriers_redx.sql — Courier integration for KBB (RedX first)
--
-- * courier_accounts: one row per courier (RedX now; Pathao/Steadfast
--   later). API token lives in Supabase Vault; browsers never see it.
-- * courier_brand_stores: one courier "pickup store" per brand, so each
--   brand's parcels are booked under the brand's own name (KBB's address
--   and phone).
-- * courier_areas / courier_area_aliases: the courier's delivery areas and
--   the city -> area choices KBB made, so matching gets better over time.
-- * courier_parcels / courier_events: every booking and every status the
--   courier sent us.
--
-- Status rules (agreed with the business):
--   booking                -> order "preparing_for_delivery" + tracking
--   delivery-in-progress   -> "out_for_delivery" (+ Shopify fulfillment)
--   delivered              -> "delivered", cash collected = booked COD
--   anything else          -> recorded on the order timeline only; KBB
--                             updates failed / returned orders by hand.
--
-- Only additions: no existing function or policy is changed.
-- Safe to run more than once. Rollback: supabase/rollbacks/053_revert_couriers_redx.sql
-- =====================================================================

begin;

-- ---------- Permission ----------------------------------------------------

insert into permissions (key, area, label, description, applies_to, sort) values
  ('couriers.manage', 'Deliveries', 'Manage courier settings', 'Courier API keys, pickup address and brand pickup stores.', '{partner}', 702)
on conflict (key) do nothing;

-- ---------- Tables ----------------------------------------------------------

create table if not exists courier_accounts (
  id                uuid primary key default gen_random_uuid(),
  courier           text not null unique check (courier in ('redx')),
  display_name      text not null,
  is_enabled        boolean not null default false,
  environment       text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  base_url          text not null,
  token_secret_id   uuid,                        -- Vault secret: API token
  tracking_url_template text not null,           -- {tracking} is replaced by the tracking id
  pickup_phone      text,
  pickup_address    text,
  pickup_area_id    integer,
  pickup_area_name  text,
  default_weight_g  integer not null default 500 check (default_weight_g > 0),
  webhook_token     text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id) on delete set null
);

create table if not exists courier_brand_stores (
  courier_account_id uuid not null references courier_accounts(id) on delete cascade,
  brand_id           uuid not null references organizations(id) on delete cascade,
  store_id           text not null,              -- courier's pickup store id
  store_name         text not null,
  created_at         timestamptz not null default now(),
  primary key (courier_account_id, brand_id)
);

create table if not exists courier_areas (
  courier       text not null,
  area_id       integer not null,
  name          text not null,
  post_code     text,
  district_name text,
  division_name text,
  zone_id       integer,
  synced_at     timestamptz not null default now(),
  primary key (courier, area_id)
);
create index if not exists courier_areas_post_code on courier_areas (courier, post_code);

create table if not exists courier_area_aliases (
  courier    text not null,
  city_key   text not null,                      -- lower(trim(city)) as typed on orders
  area_id    integer not null,
  area_name  text not null,
  updated_at timestamptz not null default now(),
  primary key (courier, city_key)
);

create table if not exists courier_parcels (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders(id) on delete cascade,
  courier_account_id uuid not null references courier_accounts(id),
  courier            text not null,
  tracking_id        text not null unique,
  tracking_url       text,
  merchant_invoice_id text not null,
  delivery_area_id   integer not null,
  delivery_area_name text not null,
  store_id           text not null,
  cod_amount         numeric not null,
  weight_g           integer not null,
  courier_status     text not null default 'booked',
  delivery_type      text,
  status_message     text,
  status_at          timestamptz,
  paid_at            timestamptz,
  is_active          boolean not null default true,   -- false once replaced by a new booking
  booked_at          timestamptz not null default now(),
  booked_by          uuid references auth.users(id) on delete set null
);
create index if not exists courier_parcels_order on courier_parcels (order_id);
create unique index if not exists courier_parcels_one_active on courier_parcels (order_id) where is_active;

create table if not exists courier_events (
  id          bigserial primary key,
  parcel_id   uuid references courier_parcels(id) on delete cascade,
  tracking_id text not null,
  status      text,
  message     text,
  payload     jsonb not null,
  applied     text,                               -- what we did with it
  received_at timestamptz not null default now()
);
create index if not exists courier_events_parcel on courier_events (parcel_id);

-- ---------- Access ----------------------------------------------------------
-- Reads: KBB and V360 staff (no token: it's only a Vault id). Writes go
-- through the functions below or the courier Edge Function (service role).

alter table courier_accounts enable row level security;
alter table courier_brand_stores enable row level security;
alter table courier_areas enable row level security;
alter table courier_area_aliases enable row level security;
alter table courier_parcels enable row level security;
alter table courier_events enable row level security;

drop policy if exists courier_accounts_read on courier_accounts;
create policy courier_accounts_read on courier_accounts for select to authenticated using (is_partner() or is_v360());
drop policy if exists courier_brand_stores_read on courier_brand_stores;
create policy courier_brand_stores_read on courier_brand_stores for select to authenticated using (is_partner() or is_v360());
drop policy if exists courier_areas_read on courier_areas;
create policy courier_areas_read on courier_areas for select to authenticated using (is_partner() or is_v360());
drop policy if exists courier_area_aliases_read on courier_area_aliases;
create policy courier_area_aliases_read on courier_area_aliases for select to authenticated using (is_partner() or is_v360());
drop policy if exists courier_parcels_read on courier_parcels;
create policy courier_parcels_read on courier_parcels for select to authenticated using (is_partner() or is_v360());
drop policy if exists courier_events_read on courier_events;
create policy courier_events_read on courier_events for select to authenticated using (is_partner() or is_v360());

revoke all on courier_accounts, courier_brand_stores, courier_areas, courier_area_aliases, courier_parcels, courier_events from anon;
grant select on courier_brand_stores, courier_areas, courier_area_aliases, courier_parcels, courier_events to authenticated;
-- courier_accounts: every column except the Vault id and the webhook token.
revoke all on courier_accounts from authenticated;
grant select (id, courier, display_name, is_enabled, environment, base_url, tracking_url_template,
              pickup_phone, pickup_address, pickup_area_id, pickup_area_name, default_weight_g, updated_at)
  on courier_accounts to authenticated;

-- ---------- Settings (KBB admins / "Manage courier settings") -------------

create or replace function can_manage_couriers() returns boolean
language sql stable security definer set search_path = public as $$
  select partner_can('couriers.manage') or is_v360_admin()
$$;

-- Empty token = keep the stored one.
create or replace function save_courier_account(
  p_courier text, p_is_enabled boolean, p_environment text, p_base_url text, p_token text,
  p_tracking_url_template text, p_pickup_phone text, p_pickup_address text,
  p_pickup_area_id integer, p_pickup_area_name text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_secret uuid;
begin
  if not can_manage_couriers() then raise exception 'Your role can''t change courier settings'; end if;
  if p_courier <> 'redx' then raise exception 'Unknown courier'; end if;
  -- RedX hosts only: the stored token is sent to this address.
  if coalesce(trim(p_base_url), '') !~* '^https://(openapi|sandbox)\.redx\.com\.bd(/|$)' then
    raise exception 'The API base URL must be openapi.redx.com.bd or sandbox.redx.com.bd';
  end if;
  -- https only: the link is shown to staff and sent to Shopify.
  if coalesce(trim(p_tracking_url_template), '') !~* '^https://' then
    raise exception 'The tracking link must start with https://';
  end if;
  if position('{tracking}' in coalesce(p_tracking_url_template, '')) = 0 then
    raise exception 'The tracking link must contain {tracking}';
  end if;

  select id, token_secret_id into v_id, v_secret from courier_accounts where courier = p_courier for update;

  if nullif(trim(p_token), '') is not null then
    if v_secret is not null then
      perform vault.update_secret(v_secret, trim(p_token));
    else
      v_secret := vault.create_secret(trim(p_token), 'courier_' || p_courier || '_token', 'Courier API token (' || p_courier || ')');
    end if;
  end if;
  if p_is_enabled and v_secret is null then raise exception 'Enter the API token before turning the courier on'; end if;

  insert into courier_accounts (courier, display_name, is_enabled, environment, base_url, token_secret_id,
                                tracking_url_template, pickup_phone, pickup_address, pickup_area_id, pickup_area_name,
                                updated_at, updated_by)
  values (p_courier, 'RedX', p_is_enabled, p_environment, rtrim(trim(p_base_url), '/'), v_secret,
          trim(p_tracking_url_template), nullif(trim(p_pickup_phone), ''), nullif(trim(p_pickup_address), ''),
          p_pickup_area_id, nullif(trim(p_pickup_area_name), ''), now(), auth.uid())
  on conflict (courier) do update set
    is_enabled = excluded.is_enabled, environment = excluded.environment, base_url = excluded.base_url,
    token_secret_id = excluded.token_secret_id, tracking_url_template = excluded.tracking_url_template,
    pickup_phone = excluded.pickup_phone, pickup_address = excluded.pickup_address,
    pickup_area_id = excluded.pickup_area_id, pickup_area_name = excluded.pickup_area_name,
    updated_at = now(), updated_by = auth.uid()
  returning id into v_id;
  return v_id;
end $$;

-- Whether a token is stored, and the webhook address token (managers only).
create or replace function courier_account_secrets(p_courier text)
returns table (token_set boolean, webhook_token text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not can_manage_couriers() then raise exception 'Your role can''t view courier settings'; end if;
  return query select a.token_secret_id is not null, a.webhook_token from courier_accounts a where a.courier = p_courier;
end $$;

create or replace function regenerate_courier_webhook_token(p_courier text)
returns text language plpgsql security definer set search_path = public as $$
declare v text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not can_manage_couriers() then raise exception 'Your role can''t change courier settings'; end if;
  update courier_accounts set webhook_token = v, updated_at = now(), updated_by = auth.uid() where courier = p_courier;
  if not found then raise exception 'Save the courier settings first'; end if;
  return v;
end $$;

-- ---------- For the courier Edge Function (service role only) -------------

create or replace function get_courier_credentials(p_courier text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', a.id, 'enabled', a.is_enabled, 'environment', a.environment, 'base_url', a.base_url,
    'tracking_url_template', a.tracking_url_template, 'pickup_phone', a.pickup_phone,
    'pickup_address', a.pickup_address, 'pickup_area_id', a.pickup_area_id, 'default_weight_g', a.default_weight_g,
    'webhook_token', a.webhook_token,
    'token', coalesce((select s.decrypted_secret from vault.decrypted_secrets s where s.id = a.token_secret_id), ''))
  from courier_accounts a where a.courier = p_courier
$$;

-- Booking done: save tracking on the order and move it to "Preparing for delivery".
create or replace function courier_record_booking(
  p_order_id uuid, p_courier_name text, p_tracking text, p_url text, p_actor text
) returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  update orders set delivery_courier = p_courier_name, delivery_tracking_number = p_tracking, delivery_tracking_url = p_url
  where id = p_order_id;
  if o.status = 'received_by_partner' then
    perform _set_order_status(p_order_id, 'preparing_for_delivery', 'Booked with ' || p_courier_name,
      'Tracking ' || p_tracking, p_actor);
  else
    perform _log_order_event(p_order_id, 'Booked with ' || p_courier_name, 'Tracking ' || p_tracking, p_actor);
  end if;
end $$;

-- A courier status update arrived. Returns what was done:
-- 'out_for_delivery' | 'delivered' | 'logged' | 'ignored:<reason>'.
create or replace function courier_apply_status(
  p_tracking text, p_status text, p_delivery_type text, p_message text, p_payload jsonb
) returns text language plpgsql security definer set search_path = public as $$
declare
  p courier_parcels%rowtype;
  o orders%rowtype;
  v_label text;
  v_applied text;
begin
  select * into p from courier_parcels where tracking_id = p_tracking;
  if not found then
    insert into courier_events (tracking_id, status, message, payload, applied)
    values (p_tracking, p_status, p_message, coalesce(p_payload, '{}'), 'ignored:unknown parcel');
    return 'ignored:unknown parcel';
  end if;
  v_label := case p.courier when 'redx' then 'RedX' else initcap(p.courier) end;

  -- Same status again (webhook retry or a manual refresh): keep the timeline clean.
  if p.courier_status = p_status and coalesce(p.delivery_type, '') = coalesce(p_delivery_type, p.delivery_type, '') then
    insert into courier_events (parcel_id, tracking_id, status, message, payload, applied)
    values (p.id, p_tracking, p_status, p_message, coalesce(p_payload, '{}'), 'ignored:unchanged');
    return 'ignored:unchanged';
  end if;

  update courier_parcels set courier_status = coalesce(p_status, courier_status), delivery_type = coalesce(p_delivery_type, delivery_type),
         status_message = p_message, status_at = now(),
         paid_at = case when p_status = 'paid' then coalesce(paid_at, now()) else paid_at end
  where id = p.id;

  select * into o from orders where id = p.order_id for update;

  if not p.is_active then
    v_applied := 'ignored:old booking';
  elsif p_status = 'delivery-in-progress' and o.status in ('received_by_partner', 'preparing_for_delivery') then
    perform _set_order_status(o.id, 'out_for_delivery', v_label || ': out for delivery', p_message, v_label);
    v_applied := 'out_for_delivery';
  elsif p_status = 'delivered' and coalesce(p_delivery_type, 'regular') not like 'partial%'
        and o.status in ('received_by_partner', 'preparing_for_delivery', 'out_for_delivery') then
    if o.status <> 'out_for_delivery' then
      perform _set_order_status(o.id, 'out_for_delivery', v_label || ': out for delivery', null, v_label);
    end if;
    update orders set cod_amount_collected = p.cod_amount, cod_currency = coalesce(cod_currency, 'BDT'), delivered_at = now()
    where id = o.id;
    perform _set_order_status(o.id, 'delivered', 'Delivered',
      v_label || ' delivered; collected ' || p.cod_amount || ' ' || coalesce(o.cod_currency, 'BDT'), v_label);
    v_applied := 'delivered';
  else
    -- Failed, hold, returning, returned, area change, paid, partial: KBB decides.
    perform _log_order_event(o.id, v_label || ': ' || coalesce(p_status, 'update')
      || case when p_delivery_type like 'partial%' then ' (partial — check and update by hand)' else '' end,
      p_message, v_label);
    v_applied := 'logged';
  end if;

  insert into courier_events (parcel_id, tracking_id, status, message, payload, applied)
  values (p.id, p_tracking, p_status, p_message, coalesce(p_payload, '{}'), v_applied);
  return v_applied;
end $$;

revoke all on function
  can_manage_couriers(), save_courier_account(text, boolean, text, text, text, text, text, text, integer, text),
  courier_account_secrets(text), regenerate_courier_webhook_token(text),
  get_courier_credentials(text), courier_record_booking(uuid, text, text, text, text),
  courier_apply_status(text, text, text, text, jsonb)
from public, anon;
grant execute on function
  can_manage_couriers(), save_courier_account(text, boolean, text, text, text, text, text, text, integer, text),
  courier_account_secrets(text), regenerate_courier_webhook_token(text)
to authenticated;
revoke execute on function get_courier_credentials(text), courier_record_booking(uuid, text, text, text, text),
  courier_apply_status(text, text, text, text, jsonb) from authenticated;

commit;
