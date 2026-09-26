-- =====================================================================
-- 045_restock_available_for_sku_dispatch.sql
-- The "Restocked in BD" page shows Available = units restocked -
-- qty_dispatched_from_restock (bd_restocked_items.available_qty).
--
-- create_inbound_batch only increments qty_dispatched_from_restock for
-- SKU-less items; SKU items are deducted from brand_inventory instead, so
-- a restocked SKU line never showed as used after a brand dispatched it
-- from local inventory.
--
--   * Trigger: when a line's inventory_qty (units a dispatch took from BD
--     stock) changes on a SKU item, the same number of units is marked
--     used on that brand's restocked lines with the same SKU, oldest
--     first (or released, newest first, if it goes down). Works with
--     whichever create_inbound_batch version is live.
--   * Backfill for dispatches made before this trigger existed.
-- Units beyond what was restocked (stock the brand added by hand) are
-- ignored here: they were never on the restocked page.
-- =====================================================================

create or replace function _consume_restock_for_sku(p_brand uuid, p_sku text, p_delta int)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_left int := abs(p_delta);
  v_use  int;
  r      record;
begin
  if p_delta = 0 or p_sku is null then return; end if;

  if p_delta > 0 then
    for r in
      select oi.id, coalesce(oi.restock_qty, oi.quantity) - oi.qty_dispatched_from_restock as avail
      from order_items oi join orders o on o.id = oi.order_id
      where o.brand_id = p_brand and oi.sku = p_sku and oi.return_disposition = 'restock_in_bd'
        and coalesce(oi.restock_qty, oi.quantity) > oi.qty_dispatched_from_restock
      order by oi.id
      for update of oi
    loop
      exit when v_left <= 0;
      v_use := least(v_left, r.avail);
      update order_items set qty_dispatched_from_restock = qty_dispatched_from_restock + v_use where id = r.id;
      v_left := v_left - v_use;
    end loop;
  else
    for r in
      select oi.id, oi.qty_dispatched_from_restock as used
      from order_items oi join orders o on o.id = oi.order_id
      where o.brand_id = p_brand and oi.sku = p_sku and oi.return_disposition = 'restock_in_bd'
        and oi.qty_dispatched_from_restock > 0
      order by oi.id desc
      for update of oi
    loop
      exit when v_left <= 0;
      v_use := least(v_left, r.used);
      update order_items set qty_dispatched_from_restock = qty_dispatched_from_restock - v_use where id = r.id;
      v_left := v_left - v_use;
    end loop;
  end if;
end $$;

revoke all on function _consume_restock_for_sku(uuid, text, int) from public, anon, authenticated;

create or replace function sync_restock_used_from_dispatch()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_brand uuid;
begin
  if new.sku is null or coalesce(new.inventory_qty, 0) = coalesce(old.inventory_qty, 0) then return new; end if;
  select brand_id into v_brand from orders where id = new.order_id;
  perform _consume_restock_for_sku(v_brand, new.sku, coalesce(new.inventory_qty, 0) - coalesce(old.inventory_qty, 0));
  return new;
end $$;

revoke all on function sync_restock_used_from_dispatch() from public, anon, authenticated;

drop trigger if exists sync_restock_used_from_dispatch on order_items;
create trigger sync_restock_used_from_dispatch
  after update of inventory_qty on order_items
  for each row execute function sync_restock_used_from_dispatch();

-- ---------- Backfill dispatches made before the trigger --------------
do $$
declare
  r record;
begin
  for r in
    select o.brand_id, oi.sku, sum(oi.inventory_qty)::int as used
    from order_items oi join orders o on o.id = oi.order_id
    where oi.inventory_qty > 0 and oi.sku is not null
    group by o.brand_id, oi.sku
  loop
    perform _consume_restock_for_sku(r.brand_id, r.sku, r.used);
  end loop;
end $$;
