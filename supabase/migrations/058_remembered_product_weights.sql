-- =====================================================================
-- 058_remembered_product_weights.sql — remember item weights at the hub
--
-- Until now the receiving dialog asked for the weight of every item on
-- every order, then kept only the order total (order_freight_weights).
-- The per-item weights were thrown away, so "Gulal" had to be weighed
-- again each time it arrived.
--
-- This adds a small memory of "one unit of this product weighs X kg":
--
--   * product_weights          one row per brand + product name. All
--                              sizes/variants of a product share one
--                              weight (user decision, 2026-09-30).
--   * remembered_item_weights  read: the saved weight for each item line
--                              of an order, used to pre-fill the dialog.
--   * receive_order_weighed    write: calls the existing receive_order
--                              unchanged, then saves the item weights the
--                              operator confirmed. A changed weight
--                              replaces the remembered one.
--
-- receive_order itself is NOT modified (its live definition has been
-- patched by several migrations), so receiving behaves exactly as before;
-- the permission check (hub.receive) still happens inside it.
--
-- Orders received before this migration are not touched and nothing is
-- back-filled: their per-item weights were never stored.
--
-- Rollback: supabase/rollbacks/058_revert_remembered_product_weights.sql
-- =====================================================================

begin;

-- ---------- 1. The memory ------------------------------------------------

create table if not exists product_weights (
  brand_id     uuid not null references organizations(id) on delete cascade,
  product_key  text not null,               -- product name, lower-cased, spaces collapsed
  product_name text not null,               -- as last seen, for reading the table by hand
  weight_kg    numeric(10,3) not null check (weight_kg > 0),   -- one unit
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null,
  primary key (brand_id, product_key)
);

-- Reached only through the two functions below.
alter table product_weights enable row level security;
revoke all on product_weights from public, anon, authenticated;

create or replace function _product_weight_key(p_name text)
returns text language sql immutable as $$
  select lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')))
$$;

revoke all on function _product_weight_key(text) from public, anon, authenticated;

-- ---------- 2. Read: saved weights for an order's items -------------------

create or replace function remembered_item_weights(p_order_id uuid)
returns table (item_id uuid, weight_kg numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(v360_can('hub.receive'), false) then
    raise exception 'You do not have permission to receive orders at the hub';
  end if;

  return query
  select i.id, w.weight_kg
  from order_items i
  join orders o on o.id = i.order_id
  join product_weights w on w.brand_id = o.brand_id
                        and w.product_key = _product_weight_key(i.product_name)
  where i.order_id = p_order_id;
end $$;

revoke all on function remembered_item_weights(uuid) from public, anon;
grant execute on function remembered_item_weights(uuid) to authenticated;

-- ---------- 3. Write: receive, then remember ------------------------------
-- p_item_weights: [{"item_id": "...", "weight_kg": 0.35}, ...] — one unit each.

create or replace function receive_order_weighed(
  p_order_id        uuid,
  p_order_weight_kg numeric,
  p_items           jsonb default null,
  p_note            text  default null,
  p_item_weights    jsonb default null
)
returns order_status
language plpgsql security definer set search_path = public as $$
declare
  v_result order_status;
begin
  -- Permission, status and weight checks all live in receive_order.
  v_result := receive_order(p_order_id, p_order_weight_kg, p_items, p_note);

  if p_item_weights is not null and jsonb_typeof(p_item_weights) = 'array' then
    insert into product_weights (brand_id, product_key, product_name, weight_kg, updated_at, updated_by)
    -- two lines of the same product (e.g. two sizes) in one order: the last line wins
    select distinct on (o.brand_id, _product_weight_key(i.product_name))
           o.brand_id, _product_weight_key(i.product_name), btrim(i.product_name),
           round((x.v->>'weight_kg')::numeric, 3), now(), auth.uid()
    from jsonb_array_elements(p_item_weights) with ordinality as x(v, n)
    join order_items i on i.id = (x.v->>'item_id')::uuid and i.order_id = p_order_id
    join orders o on o.id = i.order_id
    where round((x.v->>'weight_kg')::numeric, 3) > 0
      and _product_weight_key(i.product_name) <> ''
    order by o.brand_id, _product_weight_key(i.product_name), x.n desc
    on conflict (brand_id, product_key) do update set
      weight_kg    = excluded.weight_kg,
      product_name = excluded.product_name,
      updated_at   = now(),
      updated_by   = excluded.updated_by;
  end if;

  return v_result;
end $$;

revoke all on function receive_order_weighed(uuid, numeric, jsonb, text, jsonb) from public, anon;
grant execute on function receive_order_weighed(uuid, numeric, jsonb, text, jsonb) to authenticated;

commit;
