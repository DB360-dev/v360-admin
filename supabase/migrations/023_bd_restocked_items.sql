-- =====================================================================
-- 023_bd_restocked_items.sql
-- Flat view of every order line in orders that were returned and whose
-- disposition is "restock in Bangladesh", pre-joined with brand,
-- shipment and the restock decision note/time — powers the
-- "Restocked in BD" page.
-- security_invoker ensures the view respects orders/order_items RLS
-- (V360 admin and KBB partner can both read all Bangladesh orders).
-- =====================================================================

create view bd_restocked_items with (security_invoker = true) as
select
  oi.id                       as order_item_id,
  o.id                        as order_id,
  o.order_number,
  o.order_date,
  o.status,
  o.status_changed_at         as returned_at,
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
  o.return_disposition,
  rd.created_at               as restocked_at,
  rd.note                     as restock_note,
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
left join lateral (
  select e.created_at, e.note
  from order_events e
  where e.order_id = o.id
    and e.action = 'Return disposition: restock_in_bd'
  order by e.created_at desc
  limit 1
) rd on true
where o.status = 'returned'
  and o.return_disposition = 'restock_in_bd';

grant select on bd_restocked_items to authenticated;
