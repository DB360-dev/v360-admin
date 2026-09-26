-- =====================================================================
-- 040_brand_payout_full_return_deduction.sql
-- Brand payout invoice, revised:
--   Total parcels amount (delivered + returned, full price)
--   − V360 commission on delivered orders only (returned: 0 commission)
--   − Returned orders' full amount
--   = Payable to brand
-- e.g. delivered 10,000 + returned 5,000 = 15,000; commission 15% = 1,500;
--      payable = 15,000 − 1,500 − 5,000 = 8,500.
-- Each order line now also stores its items for the detail page.
-- Stored totals: total_value = parcels amount, net_remaining = commission,
-- advance_amount = returned amount, payable_amount = payable.
-- =====================================================================

create or replace function create_brand_payout_invoice(p_brand_id uuid, p_order_ids uuid[])
returns text language plpgsql security definer set search_path = public as $$
declare
  v_pct     numeric := coalesce(
    (select v360_commission_pct from brand_money_settings where brand_id = p_brand_id),
    (select v360_commission_pct from money_settings where id = 1), 15);
  v_number  text;
  v_lines   jsonb;
  v_count   int;
  v_deliv   numeric;
  v_ret     numeric;
  v_comm    numeric;
  v_ded     numeric;
begin
  if not is_v360() then raise exception 'Only V360 can create brand payout invoices'; end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 then raise exception 'Choose at least one order'; end if;

  perform 1 from orders where id = any(p_order_ids) for update;

  if exists (select 1 from orders o where o.id = any(p_order_ids)
             and (o.brand_id <> p_brand_id or not _brand_payout_eligible(o))) then
    raise exception 'Some orders are from another brand, not settled by KBB yet, or already on a brand invoice';
  end if;

  with x as (
    select o.id, o.order_number, o.order_date, o.status, o.returned_due_to_discrepancy, o.customer_name, o.city,
           coalesce(nullif(o.cod_amount_expected, 0), o.order_total) as value,
           o.status = 'delivered' as delivered,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'product_name', i.product_name, 'variant', i.variant, 'sku', i.sku,
                     'quantity', i.quantity, 'unit_price', i.unit_price, 'discount', i.discount)
                   order by i.product_name), '[]'::jsonb)
              from order_items i where i.order_id = o.id) as items
    from orders o where o.id = any(p_order_ids)
  )
  select count(*),
         coalesce(sum(value) filter (where delivered), 0),
         coalesce(sum(value) filter (where not delivered), 0),
         jsonb_agg(jsonb_build_object(
           'order_id', id, 'order_number', order_number, 'order_date', order_date, 'status', status,
           'returned_due_to_discrepancy', returned_due_to_discrepancy,
           'customer_name', customer_name, 'city', city, 'items', items,
           'value', value,
           'commission', case when delivered then round(value * v_pct / 100, 2) else 0 end,
           'returned_deduction', case when delivered then 0 else value end,
           'payable', case when delivered then round(value - value * v_pct / 100, 2) else 0 end
         ) order by order_number)
    into v_count, v_deliv, v_ret, v_lines
  from x;

  v_comm := round(v_deliv * v_pct / 100, 2);
  v_ded  := v_ret;   -- returned orders are deducted in full
  v_number := 'INV-BRAND-' || lpad(nextval('brand_payout_invoice_seq')::text, 5, '0');

  insert into invoices (invoice_number, invoice_type, brand_id, order_ids, order_count, brand_count,
                        total_value, advance_amount, net_remaining, payable_amount, payment_status, lines, notes)
  values (v_number, 'brand_payout', p_brand_id, p_order_ids, v_count, 1,
          v_deliv + v_ret, v_ded, v_comm, round((v_deliv + v_ret) - v_comm - v_ded, 2), 'not_paid',
          jsonb_build_object('v360_commission_pct', v_pct, 'delivered_value', v_deliv,
                             'returned_value', v_ret, 'orders', v_lines),
          null);

  update orders set brand_payout_invoice = v_number where id = any(p_order_ids);
  return v_number;
end $$;

