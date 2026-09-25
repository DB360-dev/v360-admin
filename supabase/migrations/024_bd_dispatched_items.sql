-- =====================================================================
-- 024_bd_dispatched_items.sql
-- Flat view of every order line in orders that KBB has dispatched from
-- the Bangladesh warehouse for customer delivery — powers the "Order"
-- tab on the Inventory page. Includes delivered, failed and in-flight
-- last-mile statuses.
-- security_invoker respects orders/order_items RLS (V360 + KBB).
-- =====================================================================

create view bd_dispatched_items with (security_invoker = true) as
select
  oi.id                       as order_item_id,
  o.id                        as order_id,
  o.order_number,
  o.order_date,
  o.status,
  o.status_changed_at         as dispatched_at,
  o.brand_id,
  b.name                      as brand_name,
  o.customer_name,
  o.customer_phone,
  o.city,
  o.province,
  o.order_total,
  o.currency,
  o.delivered_at,
  o.delivery_courier,
  o.delivery_tracking_number,
  o.failure_reason,
  s.id                        as shipment_id,
  s.code                      as shipment_code,
  oi.product_name,
  oi.sku,
  oi.variant,
  oi.quantity,
  oi.unit_price,
  oi.discount,
  (oi.quantity * oi.unit_price) - oi.discount as line_total
from order_items oi
join orders o on o.id = oi.order_id
join organizations b on b.id = o.brand_id
left join shipments s on s.id = o.shipment_id
where o.status in ('received_by_partner', 'preparing_for_delivery', 'out_for_delivery', 'delivered', 'delivery_failed');

grant select on bd_dispatched_items to authenticated;