-- =====================================================================
-- 039_brand_payout_invoices.sql
-- Brand payout invoice: what V360 pays a brand for orders KBB has already
-- settled (on a final settlement invoice).
--   Delivered value
--   − V360 commission (brand's v360_commission_pct, default money_settings)
--   − 50% of returned value (returned / failed / cancelled after dispatch,
--     whether the stock is in Bangladesh or Pakistan)
--   = payable to the brand
-- Order value = COD expected, or the order total for prepaid orders (same
-- as the settlement invoice). Shipping charges stay on their own invoices.
-- Each order can be on one brand payout invoice only.
-- =====================================================================

alter table invoices
  add column if not exists brand_id uuid references organizations(id),
  add column if not exists lines    jsonb;   -- per-order snapshot for brand payouts

alter table orders
  add column if not exists brand_payout_invoice text;

create sequence if not exists brand_payout_invoice_seq;

-- Orders a brand can be paid for: KBB-settled, delivered or returned, not yet paid out.
create or replace function _brand_payout_eligible(o orders) returns boolean
language sql stable as $$
  select o.is_settled
     and o.brand_payout_invoice is null
     and o.status in ('delivered', 'returned', 'delivery_failed', 'cancelled')
$$;

create or replace view brand_payout_candidates with (security_invoker = true) as
select o.id, o.brand_id, b.name as brand_name, o.order_number, o.order_date, o.status,
       o.returned_due_to_discrepancy, o.customer_name, o.city,
       coalesce(nullif(o.cod_amount_expected, 0), o.order_total) as order_value,
       o.delivered_at, o.settled_at
from orders o
join organizations b on b.id = o.brand_id
where _brand_payout_eligible(o);

grant select on brand_payout_candidates to authenticated;

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
    select o.id, o.order_number, o.status, o.returned_due_to_discrepancy,
           coalesce(nullif(o.cod_amount_expected, 0), o.order_total) as value,
           o.status = 'delivered' as delivered
    from orders o where o.id = any(p_order_ids)
  )
  select count(*),
         coalesce(sum(value) filter (where delivered), 0),
         coalesce(sum(value) filter (where not delivered), 0),
         jsonb_agg(jsonb_build_object(
           'order_id', id, 'order_number', order_number, 'status', status,
           'returned_due_to_discrepancy', returned_due_to_discrepancy,
           'value', value,
           'commission', case when delivered then round(value * v_pct / 100, 2) else 0 end,
           'returned_deduction', case when delivered then 0 else round(value * 0.5, 2) end,
           'payable', case when delivered then round(value - value * v_pct / 100, 2) else round(-value * 0.5, 2) end
         ) order by order_number)
    into v_count, v_deliv, v_ret, v_lines
  from x;

  v_comm := round(v_deliv * v_pct / 100, 2);
  v_ded  := round(v_ret * 0.5, 2);
  v_number := 'INV-BRAND-' || lpad(nextval('brand_payout_invoice_seq')::text, 5, '0');

  insert into invoices (invoice_number, invoice_type, brand_id, order_ids, order_count, brand_count,
                        total_value, advance_amount, net_remaining, payable_amount, payment_status, lines, notes)
  values (v_number, 'brand_payout', p_brand_id, p_order_ids, v_count, 1,
          v_deliv + v_ret, v_ded, v_comm, round(v_deliv - v_comm - v_ded, 2), 'not_paid',
          jsonb_build_object('v360_commission_pct', v_pct, 'delivered_value', v_deliv,
                             'returned_value', v_ret, 'orders', v_lines),
          null);

  update orders set brand_payout_invoice = v_number where id = any(p_order_ids);
  return v_number;
end $$;

revoke all on function create_brand_payout_invoice(uuid, uuid[]) from public, anon;
grant execute on function create_brand_payout_invoice(uuid, uuid[]) to authenticated;

-- delete_invoice (033) also frees orders of a brand payout invoice.
create or replace function delete_invoice(p_invoice_number text)
returns void language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype;
begin
  if not is_v360() then raise exception 'Only V360 can delete invoices'; end if;
  select * into inv from invoices where invoice_number = p_invoice_number for update;
  if not found then raise exception 'Invoice % not found', p_invoice_number; end if;

  if inv.invoice_type = 'brand_payout' then
    update orders set brand_payout_invoice = null where brand_payout_invoice = inv.invoice_number;
  elsif inv.invoice_type = 'final_settlement' then
    if exists (select 1 from orders o
               where o.brand_payout_invoice is not null
                 and (o.id = any(coalesce(inv.order_ids, '{}')) or o.shipment_id = any(coalesce(inv.shipment_ids, '{}')))) then
      raise exception 'Some orders on % are already on a brand payout invoice. Delete that brand invoice first.', inv.invoice_number;
    end if;
    if inv.shipment_ids is not null and array_length(inv.shipment_ids, 1) > 0 then
      update shipments set is_settled = false, settled_at = null where id = any(inv.shipment_ids);
      update orders set is_settled = false, settled_at = null where shipment_id = any(inv.shipment_ids);
    end if;
    if inv.order_ids is not null and array_length(inv.order_ids, 1) > 0 then
      update orders set is_settled = false, settled_at = null where id = any(inv.order_ids);
    end if;
  elsif inv.shipment_ids is not null and array_length(inv.shipment_ids, 1) > 0 then
    update shipments set invoice_payment_status = 'not_paid' where id = any(inv.shipment_ids);
  end if;

  delete from invoices where id = inv.id;
end $$;
