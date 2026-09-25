-- =====================================================================
-- 024_per_item_return_disposition.sql
-- • Adds return_disposition column to order_items for per-item decisions.
-- • Replaces set_return_disposition RPC with a per-item array variant.
-- • Updates bd_restocked_items view to filter by item-level disposition.
-- =====================================================================

-- Per-item disposition column
alter table order_items
  add column if not exists return_disposition return_disposition default null;

-- Replace RPC: now accepts a JSON array of {order_item_id, disposition}
create or replace function set_return_disposition(
  p_order_id uuid,
  p_items    jsonb,   -- [{order_item_id: uuid, disposition: return_disposition}]
  p_note     text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  item     jsonb;
  v_item   uuid;
  v_disp   return_disposition;
  v_summary return_disposition;
begin
  if not is_v360() then raise exception 'Only V360 can decide what happens to returns'; end if;

  if not exists (select 1 from orders where id = p_order_id and status = 'returned') then
    raise exception 'Order is not in returned status';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    v_item := (item->>'order_item_id')::uuid;
    v_disp := (item->>'disposition')::return_disposition;

    update order_items
    set return_disposition = v_disp
    where id = v_item and order_id = p_order_id;

    if not found then raise exception 'Item % not found in order', v_item; end if;
  end loop;

  -- Derive order-level summary: most frequent item disposition
  select return_disposition into v_summary
  from order_items
  where order_id = p_order_id and return_disposition is not null
  group by return_disposition
  order by count(*) desc
  limit 1;

  if v_summary is not null then
    update orders set return_disposition = v_summary where id = p_order_id;
  end if;

  perform _log_order_event(p_order_id, 'Return disposition saved', p_note);
end $$;

-- Update view to filter by item-level disposition
create or replace view bd_restocked_items with (security_invoker = true) as
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
  oi.return_disposition,
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
    and e.action = 'Return disposition saved'
  order by e.created_at desc
  limit 1
) rd on true
where o.status = 'returned'
  and oi.return_disposition = 'restock_in_bd';

grant select on bd_restocked_items to authenticated;
