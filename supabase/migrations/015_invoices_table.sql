-- =====================================================================
-- 015_invoices_table.sql — Invoices persistence & Settlement tracking
-- =====================================================================

-- 1. Create enum for invoice type if not exists
do $$ begin
  if not exists (select 1 from pg_type where typname = 'invoice_type') then
    create type invoice_type as enum ('dispatch_advance', 'final_settlement');
  end if;
end $$;

-- 2. Add settlement tracking columns to shipments and orders
alter table shipments 
  add column if not exists is_settled boolean not null default false,
  add column if not exists settled_at timestamptz;

alter table orders
  add column if not exists is_settled boolean not null default false,
  add column if not exists settled_at timestamptz;

-- 3. Create invoices table
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  invoice_type invoice_type not null default 'dispatch_advance',
  shipment_ids uuid[],
  order_ids uuid[],
  order_count integer not null default 0,
  brand_count integer not null default 0,
  total_value numeric not null default 0,
  advance_amount numeric not null default 0,
  net_remaining numeric not null default 0,
  payable_amount numeric not null default 0,
  payment_status invoice_payment_status not null default 'not_paid',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS
alter table invoices enable row level security;

create policy "Invoices are viewable by authenticated users"
  on invoices for select to authenticated using (true);

create policy "Invoices are manageable by staff"
  on invoices for all to authenticated using (is_v360() or is_partner());

-- Privileges
grant select, insert, update, delete on invoices to authenticated;

-- 4. Recreate shipment_overview view to include is_settled
drop view if exists order_overview cascade;
drop view if exists shipment_overview cascade;

create view shipment_overview with (security_invoker = true) as
select
  s.id, s.code, s.shipping_partner, s.tracking_number, s.origin, s.destination, s.total_weight_kg,
  s.status, s.invoice_payment_status, s.is_settled, s.settled_at, s.notes, s.created_at, s.dispatched_at, s.received_at,
  count(o.id)                        as order_count,
  count(distinct o.brand_id)         as brand_count,
  coalesce(sum(o.cod_amount_expected), 0) as cod_expected
from shipments s
left join orders o on o.shipment_id = s.id
group by s.id;

create view order_overview with (security_invoker = true) as
select
  o.id, o.order_number, o.shopify_order_id, o.order_date, o.status, o.status_changed_at,
  o.brand_id, b.name as brand_name,
  o.customer_name, o.customer_phone, o.city, o.country_code,
  o.order_total, o.currency, o.cod_amount_expected, o.cod_amount_collected, o.cod_currency,
  o.confirmation_attempts,
  o.inbound_batch_id, ib.courier as inbound_courier, ib.tracking_number as inbound_tracking,
  o.shipment_id, s.code as shipment_code, s.tracking_number as shipment_tracking,
  s.shipping_partner, s.status as shipment_status, s.invoice_payment_status as shipment_invoice_payment_status,
  o.is_settled, o.settled_at,
  o.delivery_courier, o.delivery_tracking_number, o.delivered_at,
  (select coalesce(sum(quantity), 0) from order_items i where i.order_id = o.id) as item_count,
  (select string_agg(distinct i.sku, ', ') from order_items i where i.order_id = o.id and i.sku is not null) as skus,
  now() - o.status_changed_at as time_in_status
from orders o
join organizations b on b.id = o.brand_id
left join inbound_batches ib on ib.id = o.inbound_batch_id
left join shipments s on s.id = o.shipment_id;

grant select on shipment_overview to authenticated;
grant select on order_overview to authenticated;

-- 5. RPC function to save an invoice and mark included shipments/orders as settled if final_settlement
create or replace function save_generated_invoice(
  p_invoice_number text,
  p_invoice_type invoice_type,
  p_shipment_ids uuid[],
  p_order_ids uuid[],
  p_order_count integer,
  p_brand_count integer,
  p_total_value numeric,
  p_advance_amount numeric,
  p_net_remaining numeric,
  p_payable_amount numeric
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invoice_id uuid;
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Only authorized staff can save invoices';
  end if;

  insert into invoices (
    invoice_number, invoice_type, shipment_ids, order_ids,
    order_count, brand_count, total_value, advance_amount,
    net_remaining, payable_amount, payment_status
  ) values (
    p_invoice_number, p_invoice_type, p_shipment_ids, p_order_ids,
    p_order_count, p_brand_count, p_total_value, p_advance_amount,
    p_net_remaining, p_payable_amount, 'not_paid'
  )
  on conflict (invoice_number) do update set
    total_value = excluded.total_value,
    payable_amount = excluded.payable_amount,
    updated_at = now()
  returning id into v_invoice_id;

  -- If it's a final settlement invoice, mark included shipments and orders as settled
  if p_invoice_type = 'final_settlement' then
    if p_shipment_ids is not null and array_length(p_shipment_ids, 1) > 0 then
      update shipments set is_settled = true, settled_at = now() where id = any(p_shipment_ids);
      update orders set is_settled = true, settled_at = now() where shipment_id = any(p_shipment_ids);
    end if;

    if p_order_ids is not null and array_length(p_order_ids, 1) > 0 then
      update orders set is_settled = true, settled_at = now() where id = any(p_order_ids);
    end if;
  end if;

  return v_invoice_id;
end $$;

grant execute on function save_generated_invoice(text, invoice_type, uuid[], uuid[], integer, integer, numeric, numeric, numeric, numeric) to authenticated;
