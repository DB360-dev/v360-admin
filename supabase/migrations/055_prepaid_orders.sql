-- =====================================================================
-- 055_prepaid_orders.sql — Prepaid / partly paid orders, amounts in PKR and BDT
--
-- Stores are priced in PKR; Bangladeshi customers pay in BDT. Orders keep
-- order_total (store currency, PKR) and cod_amount_expected (customer
-- currency, BDT: what KBB collects).
--
-- Rules (V360, 2026-09-28):
--   * Cash amounts (50% dispatch advance, 50% remaining, returns clawback,
--     brand payout parcels amount) use the COD amount only:
--       paid online in full -> 0, partly paid -> the unpaid part.
--   * Commissions (KBB, V360) use the full order value.
--   * KBB commission on prepaid orders is paid by V360 (it lowers what KBB
--     owes); brands are charged V360 commission only.
--   * Every amount is available in PKR and BDT (FX rate of the order date,
--     same as fx_convert / the Money page).
--
-- 1. Per-order amounts as computed columns (PostgREST: select=money_cod_pkr,...)
-- 2. Shopify import: partly paid -> unpaid part as COD; partly refunded /
--    authorized (paid online) -> 0.
-- 3. kbb_account_overview (Money page ledger), brand_payable_overview and
--    create_brand_payout_invoice follow the rules. Fully COD orders keep
--    exactly the amounts they had in the ledger.
-- Already generated invoices are not touched.
--
-- All-or-nothing. Old definitions are saved in sec055_backup for
-- supabase/rollbacks/055_revert_prepaid_orders.sql.
-- =====================================================================

begin;

create table sec055_backup (
  seq        serial primary key,
  name       text not null,
  definition text not null
);
alter table sec055_backup enable row level security;
revoke all on sec055_backup from anon, authenticated;

insert into sec055_backup (name, definition)
select p.proname, pg_get_functiondef(p.oid) from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('ingest_shopify_order', 'kbb_account_overview', 'brand_payable_overview', 'create_brand_payout_invoice');

-- ---------- 1. Per-order amounts -------------------------------------------
-- "Fully COD": the customer pays everything on delivery (nothing paid online).
-- A missing COD amount (old / manual orders) counts as fully COD at the order total.

create or replace function money_is_full_cod(o orders) returns boolean
language sql stable set search_path = public as $$
  select o.cod_amount_expected is null
      or (o.cod_amount_expected > 0 and o.payment_status is distinct from 'partially_paid')
$$;

-- Full order value, PKR. Fully COD: the COD converted (as the ledger always did).
create or replace function money_full_pkr(o orders) returns numeric
language sql stable set search_path = public as $$
  select case
    when o.cod_amount_expected > 0 and o.payment_status is distinct from 'partially_paid'
      then fx_convert(o.cod_amount_expected, coalesce(o.cod_currency, o.currency), o.order_date::date)
    else fx_convert(o.order_total, o.currency, o.order_date::date)
  end
$$;

-- Cash KBB collects, PKR.
create or replace function money_cod_pkr(o orders) returns numeric
language sql stable set search_path = public as $$
  select case
    when o.cod_amount_expected is null then fx_convert(o.order_total, o.currency, o.order_date::date)
    when o.cod_amount_expected <= 0 then 0
    else fx_convert(o.cod_amount_expected, coalesce(o.cod_currency, o.currency), o.order_date::date)
  end
$$;

-- Full order value, BDT.
create or replace function money_full_bdt(o orders) returns numeric
language sql stable set search_path = public as $$
  select case
    when o.cod_amount_expected > 0 and o.payment_status is distinct from 'partially_paid'
         and upper(coalesce(o.cod_currency, o.currency)) = 'BDT'
      then o.cod_amount_expected
    else round(money_full_pkr(o) / nullif(fx_rate_pkr('BDT', o.order_date::date), 0), 2)
  end
$$;

-- Cash KBB collects, BDT.
create or replace function money_cod_bdt(o orders) returns numeric
language sql stable set search_path = public as $$
  select case
    when o.cod_amount_expected is null then money_full_bdt(o)
    when o.cod_amount_expected <= 0 then 0
    when upper(coalesce(o.cod_currency, o.currency)) = 'BDT' then o.cod_amount_expected
    else round(money_cod_pkr(o) / nullif(fx_rate_pkr('BDT', o.order_date::date), 0), 2)
  end
$$;

revoke all on function money_is_full_cod(orders), money_full_pkr(orders), money_cod_pkr(orders),
  money_full_bdt(orders), money_cod_bdt(orders) from public, anon;
grant execute on function money_is_full_cod(orders), money_full_pkr(orders), money_cod_pkr(orders),
  money_full_bdt(orders), money_cod_bdt(orders) to authenticated, service_role;
-- The computed columns run as the caller and use these (already granted in 008; made explicit).
grant execute on function fx_rate_pkr(text, date), fx_convert(numeric, text, date) to authenticated, service_role;

-- ---------- 2. Shopify import: COD due ----------------------------------------
-- Customer currency (presentment) amount still to collect on delivery.
create or replace function _shopify_cod_due(p_financial text, p_payload jsonb, p_presentment_total numeric)
returns numeric language sql immutable as $$
  select case
    when p_financial in ('paid', 'refunded', 'partially_refunded', 'authorized') then 0
    when p_financial = 'partially_paid' then
      -- total_outstanding is in store currency: apply its share to the customer-currency total
      round(greatest(0, least(p_presentment_total,
        p_presentment_total
          * coalesce((p_payload->>'total_outstanding')::numeric,
                     (p_payload->>'current_total_price')::numeric, (p_payload->>'total_price')::numeric)
          / nullif(coalesce((p_payload->>'current_total_price')::numeric, (p_payload->>'total_price')::numeric), 0))), 2)
    else p_presentment_total
  end
$$;
revoke all on function _shopify_cod_due(text, jsonb, numeric) from public, anon, authenticated;

do $$
declare r record; v_def text; v_new text;
begin
  select p.oid into r from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'ingest_shopify_order';
  if not found then raise exception 'ingest_shopify_order not found'; end if;
  v_def := pg_get_functiondef(r.oid);
  v_new := regexp_replace(v_def,
    'case when v_financial in \(''paid'', ?''refunded''\) then 0 else v_presentment_total end',
    '_shopify_cod_due(v_financial, p_payload, v_presentment_total)', 'gi');
  if v_new = v_def then raise exception 'ingest_shopify_order: COD rule not found (was it changed?)'; end if;
  execute v_new;
end $$;

-- ---------- 2b. Saved KBB invoices keep their totals ---------------------------
-- The invoice screen re-saves an invoice each time it is opened. Invoices
-- created before this migration keep the totals they were saved with.
insert into sec055_backup (name, definition)
select p.proname, pg_get_functiondef(p.oid) from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'save_generated_invoice';

do $$
declare r record; v_def text; v_new text;
begin
  for r in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'save_generated_invoice' loop
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def,
      '(updated_at\s*=\s*now\(\))(\s*returning\s+id\s+into\s+v_invoice_id)',
      '\1' || chr(10) || format('  where invoices.created_at >= %L::timestamptz  -- 055: older invoices keep their totals', now()) || '\2',
      'i');
    if v_new = v_def then raise exception 'save_generated_invoice: ON CONFLICT clause not found (was it changed?)'; end if;
    execute v_new;
  end loop;
end $$;

-- ---------- 3a. Money page: KBB account ledger --------------------------------
-- advance_owed: 50% of the COD cash, net of KBB commission (as before).
-- total owed = COD cash − KBB commission on the full value; prepaid orders
-- make it negative (V360 pays KBB's commission). delivery_owed = the rest.
create or replace function kbb_account_overview()
returns table(shipment_id uuid, shipment_code text, shipment_status shipment_status, dispatched_at timestamptz,
              advance_owed numeric, advance_paid numeric, delivery_owed numeric, delivery_paid numeric,
              credits numeric, net_balance numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (v360_can('money.view') or partner_can('money.view')) then return; end if;
  return query
    select
      s.id,
      s.code,
      s.status,
      s.dispatched_at,
      round(0.5 * coalesce(x.adv_basis, 0), 2)                                  as advance_owed,
      round(coalesce(a.adv_paid, 0), 2)                                         as advance_paid,
      round(coalesce(x.owes_pkr, 0) - 0.5 * coalesce(x.adv_basis, 0), 2)        as delivery_owed,
      round(coalesce(d.del_paid, 0), 2)                                         as delivery_paid,
      round(coalesce(c.credits, 0), 2)                                          as credits,
      round(coalesce(x.owes_pkr, 0)
            - coalesce(a.adv_paid, 0)
            - coalesce(d.del_paid, 0)
            - coalesce(c.credits, 0), 2)                                        as net_balance
    from shipments s
    left join lateral (
      select sum(money_cod_pkr(o) * (1 - ms.kbb_commission_pct / 100))                   as adv_basis,
             sum(money_cod_pkr(o) - money_full_pkr(o) * ms.kbb_commission_pct / 100)     as owes_pkr
      from orders o cross join (select kbb_commission_pct from money_settings where id = 1) ms
      where o.shipment_id = s.id
    ) x on true
    left join lateral (
      select sum(k.amount_pkr) as adv_paid
      from kbb_payments k where k.kind = 'dispatch_advance' and k.shipment_id = s.id
    ) a on true
    left join lateral (
      select sum(k.amount_pkr) as del_paid
      from kbb_payments k
      where k.kind = 'delivery_balance'
        and k.order_id in (select o2.id from orders o2 where o2.shipment_id = s.id)
    ) d on true
    left join lateral (
      select sum(k.amount_pkr) as credits
      from kbb_payments k
      where k.kind = 'credit'
        and (k.order_id in (select o2.id from orders o2 where o2.shipment_id = s.id)
             or k.shipment_id = s.id)
    ) c on true
    where s.status >= 'handed_to_carrier'
    order by s.created_at desc;
end $$;

-- ---------- 3b. Payable to brands overview -----------------------------------
-- Fully COD orders: unchanged (order total at the delivery-date rate).
-- Prepaid / partly paid: only the COD cash is payable; commission stays on the full value.
create or replace function brand_payable_overview()
returns table(brand_id uuid, brand_name text, order_count bigint, order_total_sum numeric,
              commission_sum numeric, freight_sum numeric, payable_sum numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (v360_can('money.view') or partner_can('money.view')) then return; end if;
  return query
    select
      o.brand_id,
      b.name                                                   as brand_name,
      count(*)::bigint                                         as order_count,
      round(sum(fx_convert(o.order_total, o.currency, o.delivered_at::date)), 2) as order_total_sum,
      round(sum(fx_convert(o.order_total, o.currency, o.delivered_at::date)
                * coalesce(bms.v360_commission_pct, ms.v360_commission_pct) / 100), 2) as commission_sum,
      round(coalesce(sum(order_freight_share_pkr(o.id)), 0), 2) as freight_sum,
      round(sum(case when money_is_full_cod(o) then fx_convert(o.order_total, o.currency, o.delivered_at::date)
                     else money_cod_pkr(o) end
                - fx_convert(o.order_total, o.currency, o.delivered_at::date)
                  * coalesce(bms.v360_commission_pct, ms.v360_commission_pct) / 100)
            - coalesce(sum(order_freight_share_pkr(o.id)), 0), 2) as payable_sum
    from orders o
    join organizations b on b.id = o.brand_id
    cross join money_settings ms
    left join brand_money_settings bms on bms.brand_id = o.brand_id
    where ms.id = 1
      and o.status = 'delivered'
      and not exists (select 1 from settlement_lines sl where sl.order_id = o.id)
    group by o.brand_id, b.name, ms.v360_commission_pct, bms.v360_commission_pct
    order by b.name;
end $$;

-- ---------- 3c. Brand payout picker ------------------------------------------------
-- order_value is now the COD cash in PKR (what the payout invoice uses); new
-- columns at the end carry BDT and the full value (commission base).
insert into sec055_backup (name, definition)
select 'view:brand_payout_candidates', 'create or replace view brand_payout_candidates with (security_invoker = true) as '
       || pg_get_viewdef('brand_payout_candidates'::regclass, true);

create or replace view brand_payout_candidates with (security_invoker = true) as
select o.id, o.brand_id, b.name as brand_name, o.order_number, o.order_date, o.status,
       o.returned_due_to_discrepancy, o.customer_name, o.city,
       money_cod_pkr(o)::numeric(12,2) as order_value,   -- same type as the live column
       o.delivered_at, o.settled_at,
       money_cod_bdt(o) as order_value_bdt,
       money_full_pkr(o) as full_value,
       money_full_bdt(o) as full_value_bdt,
       not money_is_full_cod(o) as paid_online
from orders o
join organizations b on b.id = o.brand_id
where _brand_payout_eligible(o);

-- ---------- 3d. Brand payout invoice ---------------------------------------------
-- Per order: parcels amount = COD cash; V360 commission on the full value
-- (delivered only); returned orders deduct their COD cash. A prepaid delivered
-- order has payable = −commission (the brand already has the money).
-- Stored columns stay PKR; lines carry PKR and BDT for every amount.
create or replace function create_brand_payout_invoice(p_brand_id uuid, p_order_ids uuid[])
returns text language plpgsql security definer set search_path = public as $$
declare
  v_pct     numeric := coalesce(
    (select v360_commission_pct from brand_money_settings where brand_id = p_brand_id),
    (select v360_commission_pct from money_settings where id = 1), 15);
  v_number  text;
  v_lines   jsonb;
  v_count   int;
  t         record;
begin
  if not v360_can('invoices.create') then raise exception 'Only V360 can create brand payout invoices'; end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 then raise exception 'Choose at least one order'; end if;

  perform 1 from orders where id = any(p_order_ids) for update;

  if exists (select 1 from orders o where o.id = any(p_order_ids)
             and (o.brand_id <> p_brand_id or not _brand_payout_eligible(o))) then
    raise exception 'Some orders are from another brand, not settled by KBB yet, or already on a brand invoice';
  end if;

  with x as (
    select o.id, o.order_number, o.order_date, o.status, o.returned_due_to_discrepancy, o.customer_name, o.city,
           o.status = 'delivered' as delivered,
           not money_is_full_cod(o) as paid_online,
           money_cod_pkr(o) as cod_pkr, money_cod_bdt(o) as cod_bdt,
           money_full_pkr(o) as full_pkr, money_full_bdt(o) as full_bdt,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'product_name', i.product_name, 'variant', i.variant, 'sku', i.sku,
                     'quantity', i.quantity, 'unit_price', i.unit_price, 'discount', i.discount)
                   order by i.product_name), '[]'::jsonb)
              from order_items i where i.order_id = o.id) as items
    from orders o where o.id = any(p_order_ids)
  ), y as (
    select x.*,
           case when delivered then round(full_pkr * v_pct / 100, 2) else 0 end as comm_pkr,
           case when delivered then round(full_bdt * v_pct / 100, 2) else 0 end as comm_bdt,
           case when delivered then 0 else cod_pkr end as ded_pkr,
           case when delivered then 0 else cod_bdt end as ded_bdt
    from x
  )
  select count(*),
         jsonb_agg(jsonb_build_object(
           'order_id', id, 'order_number', order_number, 'order_date', order_date, 'status', status,
           'returned_due_to_discrepancy', returned_due_to_discrepancy,
           'customer_name', customer_name, 'city', city, 'items', items, 'paid_online', paid_online,
           'value', cod_pkr, 'value_bdt', cod_bdt,
           'full_value', full_pkr, 'full_value_bdt', full_bdt,
           'commission', comm_pkr, 'commission_bdt', comm_bdt,
           'returned_deduction', ded_pkr, 'returned_deduction_bdt', ded_bdt,
           'payable', case when delivered then cod_pkr - comm_pkr else 0 end,
           'payable_bdt', case when delivered then cod_bdt - comm_bdt else 0 end
         ) order by order_number)
    into v_count, v_lines
  from y;

  select coalesce(sum(cod_pkr) filter (where delivered), 0)                         as deliv_pkr,
         coalesce(sum(cod_bdt) filter (where delivered), 0)                         as deliv_bdt,
         coalesce(sum(cod_pkr) filter (where not delivered), 0)                     as ret_pkr,
         coalesce(sum(cod_bdt) filter (where not delivered), 0)                     as ret_bdt,
         coalesce(sum(round(full_pkr * v_pct / 100, 2)) filter (where delivered), 0) as comm_pkr,
         coalesce(sum(round(full_bdt * v_pct / 100, 2)) filter (where delivered), 0) as comm_bdt
    into t
  from (select o.status = 'delivered' as delivered, money_cod_pkr(o) as cod_pkr, money_cod_bdt(o) as cod_bdt,
               money_full_pkr(o) as full_pkr, money_full_bdt(o) as full_bdt
        from orders o where o.id = any(p_order_ids)) z;

  v_number := 'INV-BRAND-' || lpad(nextval('brand_payout_invoice_seq')::text, 5, '0');

  insert into invoices (invoice_number, invoice_type, brand_id, order_ids, order_count, brand_count,
                        total_value, advance_amount, net_remaining, payable_amount, payment_status, lines, notes)
  values (v_number, 'brand_payout', p_brand_id, p_order_ids, v_count, 1,
          t.deliv_pkr + t.ret_pkr, t.ret_pkr, t.comm_pkr,
          round((t.deliv_pkr + t.ret_pkr) - t.comm_pkr - t.ret_pkr, 2), 'not_paid',
          jsonb_build_object('v360_commission_pct', v_pct, 'currencies', jsonb_build_array('PKR', 'BDT'),
                             'delivered_value', t.deliv_pkr, 'returned_value', t.ret_pkr,
                             'bdt', jsonb_build_object(
                               'total_value', t.deliv_bdt + t.ret_bdt, 'delivered_value', t.deliv_bdt,
                               'returned_value', t.ret_bdt, 'commission', t.comm_bdt,
                               'payable', round((t.deliv_bdt + t.ret_bdt) - t.comm_bdt - t.ret_bdt, 2)),
                             'orders', v_lines),
          null);

  update orders set brand_payout_invoice = v_number where id = any(p_order_ids);
  return v_number;
end $$;

commit;
