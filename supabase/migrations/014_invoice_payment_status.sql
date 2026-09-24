-- =====================================================================
-- 014_invoice_payment_status.sql — Invoice Payment Status tracking
-- Adds invoice_payment_status enum ('not_paid', 'partially_paid', 'paid')
-- Updates shipments table, shipment_overview, and order_overview views.
-- =====================================================================

-- 1. Create enum type for invoice payment status
do $$ begin
  if not exists (select 1 from pg_type where typname = 'invoice_payment_status') then
    create type invoice_payment_status as enum ('not_paid', 'partially_paid', 'paid');
  end if;
end $$;

-- 2. Add invoice_payment_status column to shipments table (default 'not_paid')
alter table shipments 
  add column if not exists invoice_payment_status invoice_payment_status not null default 'not_paid';

-- 3. Recreate shipment_overview view to include invoice_payment_status
create or replace view shipment_overview with (security_invoker = true) as
select
  s.id, s.code, s.shipping_partner, s.tracking_number, s.origin, s.destination, s.total_weight_kg,
  s.status, s.invoice_payment_status, s.notes, s.created_at, s.dispatched_at, s.received_at,
  count(o.id)                        as order_count,
  count(distinct o.brand_id)         as brand_count,
  coalesce(sum(o.cod_amount_expected), 0) as cod_expected
from shipments s
left join orders o on o.shipment_id = s.id
group by s.id;

-- 4. Recreate order_overview view to include shipment_invoice_payment_status
create or replace view order_overview with (security_invoker = true) as
select
  o.id, o.order_number, o.shopify_order_id, o.order_date, o.status, o.status_changed_at,
  o.brand_id, b.name as brand_name,
  o.customer_name, o.customer_phone, o.city, o.country_code,
  o.order_total, o.currency, o.cod_amount_expected, o.cod_amount_collected, o.cod_currency,
  o.confirmation_attempts,
  o.inbound_batch_id, ib.courier as inbound_courier, ib.tracking_number as inbound_tracking,
  o.shipment_id, s.code as shipment_code, s.tracking_number as shipment_tracking,
  s.shipping_partner, s.status as shipment_status, s.invoice_payment_status as shipment_invoice_payment_status,
  o.delivery_courier, o.delivery_tracking_number, o.delivered_at,
  (select coalesce(sum(quantity), 0) from order_items i where i.order_id = o.id) as item_count,
  (select string_agg(distinct i.sku, ', ') from order_items i where i.order_id = o.id and i.sku is not null) as skus,
  now() - o.status_changed_at as time_in_status
from orders o
join organizations b on b.id = o.brand_id
left join inbound_batches ib on ib.id = o.inbound_batch_id
left join shipments s on s.id = o.shipment_id;

-- 5. RPC function to update shipment invoice payment status safely from frontend
create or replace function set_shipment_invoice_payment_status(
  p_shipment_id uuid,
  p_status invoice_payment_status
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Only authorized staff can change invoice payment status';
  end if;

  update shipments set
    invoice_payment_status = p_status
  where id = p_shipment_id;
  
  if not found then
    raise exception 'Shipment not found';
  end if;
end $$;

-- 6. Privileges
revoke execute on function set_shipment_invoice_payment_status(uuid, invoice_payment_status) from public, anon;
grant execute on function set_shipment_invoice_payment_status(uuid, invoice_payment_status) to authenticated;
