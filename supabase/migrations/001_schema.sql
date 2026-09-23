-- =====================================================================
-- 001_schema.sql — Core tables for the Bangladesh fulfilment platform
-- Parties: V360 (admin / local hub), KBB (fulfilment partner), Brands.
-- Run in the Supabase SQL Editor, in order: 001, 002, 003.
-- =====================================================================

-- ---------- Enums ----------------------------------------------------

create type org_type as enum ('v360', 'partner', 'brand');

-- Roles inside an organization.
--   v360:    admin (everything), operator (everything except user mgmt)
--   partner: partner_agent (KBB staff)
--   brand:   brand_owner, brand_staff
create type member_role as enum ('admin', 'operator', 'partner_agent', 'brand_owner', 'brand_staff');

create type order_status as enum (
  'new',
  'confirmation_pending',
  'customer_unreachable',
  'needs_amendment',
  'confirmed',
  'cancelled',
  'brand_preparing',
  'dispatched_to_hub',
  'received_at_hub',
  'hub_issue',
  'ready_for_shipment',
  'assigned_to_shipment',
  'shipped',
  'in_transit',
  'customs',
  'arrived_bd',
  'received_by_partner',
  'preparing_for_delivery',
  'out_for_delivery',
  'delivered',
  'delivery_failed',
  'returned',
  'hold'
);

create type shipment_status as enum (
  'draft',
  'ready_for_dispatch',
  'handed_to_carrier',
  'in_transit',
  'customs',
  'arrived_bd',
  'received_by_partner'
);

create type inbound_status as enum ('in_transit', 'received', 'issue');

create type return_disposition as enum ('pending', 'restock_in_bd', 'return_to_pk', 'written_off');

-- ---------- Organizations & people ----------------------------------

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        org_type not null,
  slug        text unique,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Only one V360 org should exist.
create unique index one_v360_org on organizations ((type)) where type = 'v360';

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text,
  phone       text,
  created_at  timestamptz not null default now()
);

create table memberships (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  organization_id  uuid not null references organizations(id) on delete cascade,
  role             member_role not null,
  created_at       timestamptz not null default now(),
  unique (user_id, organization_id)
);
create index on memberships (user_id);

-- ---------- Shopify connection per brand ----------------------------
-- The access token itself lives in Supabase Vault; we only keep its id.

create table shopify_connections (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null unique references organizations(id) on delete cascade,
  shop_domain       text not null unique,          -- e.g. binilyas.myshopify.com
  token_secret_id   uuid,                          -- vault.secrets.id
  scopes            text,
  status            text not null default 'pending', -- pending | active | error | uninstalled
  last_synced_at    timestamptz,
  installed_at      timestamptz,
  created_at        timestamptz not null default now()
);

-- Raw webhook log: guarantees idempotency and lets us replay failures.
create table webhook_events (
  id            bigserial primary key,
  webhook_id    text not null unique,     -- X-Shopify-Webhook-Id header
  topic         text not null,
  shop_domain   text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);

-- ---------- Inbound batches (Brand -> V360 hub, e.g. TCS) -----------

create table inbound_batches (
  id               uuid primary key default gen_random_uuid(),
  brand_id         uuid not null references organizations(id),
  courier          text not null,          -- TCS, Leopards, M&P, hand delivery...
  tracking_number  text,
  dispatch_date    date not null default current_date,
  status           inbound_status not null default 'in_transit',
  courier_status   text,                   -- raw status text from courier API
  notes            text,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  received_at      timestamptz
);
create index on inbound_batches (brand_id);

-- ---------- Consolidated shipments (V360 hub -> KBB) ----------------

create sequence shipment_code_seq;

create table shipments (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique default ('SH-' || lpad(nextval('shipment_code_seq')::text, 4, '0')),
  shipping_partner  text,
  tracking_number   text,
  origin            text not null default 'Lahore, PK',
  destination       text not null default 'Dhaka, BD',
  total_weight_kg   numeric(10,2),
  status            shipment_status not null default 'draft',
  notes             text,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  dispatched_at     timestamptz,
  received_at       timestamptz
);

-- ---------- Orders ---------------------------------------------------

create table orders (
  id                      uuid primary key default gen_random_uuid(),
  brand_id                uuid not null references organizations(id),

  -- Shopify identity
  shopify_order_id        bigint not null,
  order_number            text not null,          -- e.g. #1001
  order_date              timestamptz not null,

  -- Customer
  customer_name           text,
  customer_phone          text,
  customer_email          text,
  address1                text,
  address2                text,
  city                    text,
  province                text,
  zip                     text,
  country_code            text not null,          -- 'BD'

  -- Money (in the Shopify order currency)
  currency                text not null,
  subtotal                numeric(12,2) not null default 0,
  discount_total          numeric(12,2) not null default 0,
  shipping_total          numeric(12,2) not null default 0,
  order_total             numeric(12,2) not null default 0,
  payment_status          text,                   -- Shopify financial_status
  cod_amount_expected     numeric(12,2),          -- what KBB should collect
  cod_amount_collected    numeric(12,2),          -- entered by KBB on delivery
  cod_currency            text,                   -- usually BDT

  customer_note           text,
  shopify_note            text,

  -- Workflow
  status                  order_status not null default 'new',
  previous_status         order_status,           -- used to resume from 'hold'
  status_changed_at       timestamptz not null default now(),
  confirmation_attempts   int not null default 0,
  confirmed_at            timestamptz,
  confirmed_by            uuid references auth.users(id),

  -- Brand dispatch
  inbound_batch_id        uuid references inbound_batches(id),

  -- Hub
  received_at_hub_at      timestamptz,
  hub_notes               text,

  -- Shipment
  shipment_id             uuid references shipments(id),

  -- Bangladesh last mile (KBB's courier)
  delivery_courier        text,
  delivery_tracking_number text,
  delivered_at            timestamptz,
  failure_reason          text,
  return_disposition      return_disposition,

  shopify_cancelled_at    timestamptz,
  shopify_payload_hash    text,                   -- detects real changes vs duplicate webhooks
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (brand_id, shopify_order_id)
);
create index on orders (brand_id, status);
create index on orders (status);
create index on orders (shipment_id);
create index on orders (inbound_batch_id);

create table order_items (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id) on delete cascade,
  shopify_line_item_id  bigint,
  product_name          text not null,
  sku                   text,
  variant               text,
  quantity              int not null check (quantity > 0),
  unit_price            numeric(12,2) not null default 0,
  discount              numeric(12,2) not null default 0,
  received_quantity     int not null default 0 check (received_quantity >= 0),
  unique (order_id, shopify_line_item_id)
);
create index on order_items (order_id);

-- ---------- Timelines (audit trail) ---------------------------------

create table order_events (
  id           bigserial primary key,
  order_id     uuid not null references orders(id) on delete cascade,
  actor_id     uuid references auth.users(id),   -- null = system / Shopify
  actor_label  text,                             -- 'Shopify', 'System', or org name
  action       text not null,
  from_status  order_status,
  to_status    order_status,
  note         text,
  created_at   timestamptz not null default now()
);
create index on order_events (order_id, created_at);

create table shipment_events (
  id            bigserial primary key,
  shipment_id   uuid not null references shipments(id) on delete cascade,
  actor_id      uuid references auth.users(id),
  action        text not null,
  from_status   shipment_status,
  to_status     shipment_status,
  note          text,
  created_at    timestamptz not null default now()
);
create index on shipment_events (shipment_id, created_at);

-- ---------- Manual FX rates -----------------------------------------

create table fx_rates (
  id          bigserial primary key,
  rate_date   date not null,
  base        text not null,     -- e.g. BDT
  quote       text not null,     -- e.g. PKR
  rate        numeric(18,6) not null check (rate > 0),
  entered_by  uuid references auth.users(id),
  note        text,
  created_at  timestamptz not null default now(),
  unique (rate_date, base, quote)
);

-- ---------- updated_at helper ---------------------------------------

create function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();
