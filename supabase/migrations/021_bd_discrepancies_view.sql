-- =====================================================================
-- 021_bd_discrepancies_view.sql
-- Flat view of all BD receiving discrepancies (received_qty <> expected_qty),
-- pre-joined with shipment code, order number, and product details.
-- security_invoker ensures the view respects bd_received_items RLS.
-- =====================================================================

create view bd_discrepancies with (security_invoker = true) as
select
  r.id,
  r.shipment_id,
  r.order_id,
  r.order_item_id,
  r.expected_qty,
  r.received_qty,
  r.received_qty - r.expected_qty as difference,
  r.note,
  r.checked_at,
  s.code        as shipment_code,
  o.order_number,
  oi.product_name,
  oi.sku,
  oi.variant
from bd_received_items r
join shipments   s  on s.id  = r.shipment_id
join orders      o  on o.id  = r.order_id
join order_items oi on oi.id = r.order_item_id
where r.received_qty <> r.expected_qty;

grant select on bd_discrepancies to authenticated;
