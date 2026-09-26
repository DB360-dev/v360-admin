-- =====================================================================
-- 044_restocked_items_into_local_stock.sql
-- Items restocked in Bangladesh (order_items.return_disposition =
-- 'restock_in_bd') must show up in the brand's local stock
-- (brand_inventory), because the brand portal's dispatch dialog only
-- offers "Fulfilled by Inventory" for SKU items that have stock there.
--
-- The brand-portal migration that was meant to do this (its 016,
-- sync_local_stock_from_restock) was never applied to this database, so
-- restocked SKU items never reached brand_inventory.
--
--   * Trigger on order_items keeps brand_inventory in sync. It counts the
--     units actually restocked (restock_qty when set, e.g. a short
--     receipt, otherwise the line quantity) and reacts to changes in the
--     disposition, restock_qty, quantity or SKU.
--   * One-off backfill for lines restocked before the trigger existed,
--     minus units already dispatched from BD inventory for that SKU.
-- SKU-less lines are unchanged: dispatch still takes them from the
-- restocked lines directly (qty_dispatched_from_restock).
-- =====================================================================

alter table order_items add column if not exists restock_qty int
  check (restock_qty is null or restock_qty >= 0);

create or replace function sync_local_stock_from_restock()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_brand   uuid;
  v_old_qty int := 0;
  v_new_qty int := 0;
begin
  select brand_id into v_brand from orders where id = coalesce(new.order_id, old.order_id);
  if v_brand is null then return coalesce(new, old); end if;

  if tg_op in ('UPDATE', 'DELETE') and old.return_disposition = 'restock_in_bd' and old.sku is not null then
    v_old_qty := coalesce(old.restock_qty, old.quantity);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.return_disposition = 'restock_in_bd' and new.sku is not null then
    v_new_qty := coalesce(new.restock_qty, new.quantity);
  end if;

  -- Take the old units off the old SKU, then add the new units to the new SKU.
  if v_old_qty > 0 then
    update brand_inventory
    set quantity_available = greatest(0, quantity_available - v_old_qty), updated_at = now()
    where brand_id = v_brand and sku = old.sku;
  end if;
  if v_new_qty > 0 then
    insert into brand_inventory (brand_id, sku, quantity_available, updated_by)
    values (v_brand, new.sku, v_new_qty, null)
    on conflict (brand_id, sku) do update set
      quantity_available = brand_inventory.quantity_available + excluded.quantity_available,
      updated_by = null,
      updated_at = now();
  end if;

  return coalesce(new, old);
end $$;

revoke all on function sync_local_stock_from_restock() from public, anon, authenticated;

drop trigger if exists sync_local_stock_from_restock on order_items;
create trigger sync_local_stock_from_restock
  after insert or update of return_disposition, restock_qty, quantity, sku or delete on order_items
  for each row execute function sync_local_stock_from_restock();

-- ---------- Backfill lines restocked before the trigger existed ------
-- Available = units restocked - units already dispatched from BD
-- inventory for the same brand + SKU (those dispatches ran while
-- brand_inventory had no row, so nothing was deducted then).
with restocked as (
  select o.brand_id, oi.sku, sum(coalesce(oi.restock_qty, oi.quantity)) as qty
  from order_items oi join orders o on o.id = oi.order_id
  where oi.return_disposition = 'restock_in_bd' and oi.sku is not null
  group by o.brand_id, oi.sku
), used as (
  select o.brand_id, oi.sku, sum(oi.inventory_qty) as qty
  from order_items oi join orders o on o.id = oi.order_id
  where oi.inventory_qty > 0 and oi.sku is not null
  group by o.brand_id, oi.sku
)
insert into brand_inventory (brand_id, sku, quantity_available, updated_by)
select r.brand_id, r.sku, greatest(0, r.qty - coalesce(u.qty, 0)), null
from restocked r left join used u on u.brand_id = r.brand_id and u.sku = r.sku
where r.qty - coalesce(u.qty, 0) > 0
on conflict (brand_id, sku) do update set
  quantity_available = brand_inventory.quantity_available + excluded.quantity_available,
  updated_at = now();
