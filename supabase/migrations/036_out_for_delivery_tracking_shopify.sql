-- =====================================================================
-- 036_out_for_delivery_tracking_shopify.sql
-- * Delivery tracking gets a tracking link.
-- * "Out for delivery" now always comes with tracking: courier, number and
--   optional link are saved and the status changes in one step.
-- * Columns to record the Shopify fulfillment that the shopify-fulfill
--   Edge Function creates (id, time, last error).
-- =====================================================================

alter table orders
  add column if not exists delivery_tracking_url     text,
  add column if not exists shopify_fulfillment_id    text,
  add column if not exists shopify_fulfilled_at      timestamptz,
  add column if not exists shopify_fulfillment_error text;

-- Tracking now takes an optional link. (Replaces the 3-argument version.)
drop function if exists set_delivery_tracking(uuid, text, text);
create or replace function set_delivery_tracking(
  p_order_id uuid, p_courier text, p_tracking_number text, p_tracking_url text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_url text := nullif(trim(coalesce(p_tracking_url, '')), '');
begin
  if not (is_v360() or is_partner()) then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_courier), '') = '' or coalesce(trim(p_tracking_number), '') = '' then
    raise exception 'Enter the courier and the tracking number';
  end if;
  if v_url is not null and v_url !~* '^https?://' then
    raise exception 'The tracking link must start with http:// or https://';
  end if;
  update orders set delivery_courier = trim(p_courier), delivery_tracking_number = trim(p_tracking_number),
                    delivery_tracking_url = v_url
  where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
  perform _log_order_event(p_order_id, 'Delivery tracking added',
    trim(p_courier) || ' — ' || trim(p_tracking_number) || coalesce(' — ' || v_url, ''));
end $$;

-- Save tracking and move to out_for_delivery together (same transition
-- rules as change_order_status).
create or replace function mark_out_for_delivery(
  p_order_id uuid, p_courier text, p_tracking_number text, p_tracking_url text default null, p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_delivery_tracking(p_order_id, p_courier, p_tracking_number, p_tracking_url);
  perform change_order_status(p_order_id, 'out_for_delivery', p_note);
end $$;

revoke all on function set_delivery_tracking(uuid, text, text, text) from public, anon;
revoke all on function mark_out_for_delivery(uuid, text, text, text, text) from public, anon;
grant execute on function set_delivery_tracking(uuid, text, text, text) to authenticated;
grant execute on function mark_out_for_delivery(uuid, text, text, text, text) to authenticated;
