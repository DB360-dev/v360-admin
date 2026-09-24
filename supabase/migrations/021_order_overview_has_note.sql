-- =====================================================================
-- 021_order_overview_has_note.sql
-- Add a has_note flag to order_overview so the All Orders table can show
-- a notes icon per order.
--
-- order_internal_notes is RLS-protected and order_overview is created with
-- security_invoker = true, so the EXISTS subquery is evaluated under the
-- caller's RLS: admins only see true when an 'admin' note exists, KBB staff
-- only when a 'kbb' note exists.
-- =====================================================================

drop view if exists order_overview cascade;

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
  o.invoice_payment_status,
  o.is_settled, o.settled_at,
  o.delivery_courier, o.delivery_tracking_number, o.delivered_at,
  exists (
    select 1 from order_internal_notes nin where nin.order_id = o.id
  ) as has_note,
  (select coalesce(sum(quantity), 0) from order_items i where i.order_id = o.id) as item_count,
  (select string_agg(distinct i.sku, ', ') from order_items i where i.order_id = o.id and i.sku is not null) as skus,
  now() - o.status_changed_at as time_in_status
from orders o
join organizations b on b.id = o.brand_id
left join inbound_batches ib on ib.id = o.inbound_batch_id
left join shipments s on s.id = o.shipment_id;

grant select on order_overview to authenticated;