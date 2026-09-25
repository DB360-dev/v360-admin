-- =====================================================================
-- 033_shipping_invoice_recalc_and_delete.sql
--
-- * "Recalculate" now rebuilds EVERY brand shipping invoice on a shipment in
--   place, paid or unpaid: same invoice number and payment status, fresh
--   lines/units/weight/amount from the current hub weights, freight rate and
--   FX. (Before, unpaid invoices were deleted and re-created with a new
--   number, and paid ones were skipped.)
-- * V360 can delete invoices: brand shipping invoices, and saved dispatch
--   advance / final settlement invoices.
-- =====================================================================

-- Rebuild one shipping invoice's lines and totals.
create or replace function _rebuild_brand_shipping_invoice(p_invoice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  inv     brand_shipping_invoices%rowtype;
  v_rate  numeric := (select freight_bdt_per_kg from money_settings where id = 1);
  v_fx    numeric := fx_rate_pkr('BDT', current_date);
begin
  if v_rate is null then
    raise exception 'Set the BDT freight rate per kg in Money settings first';
  end if;
  select * into inv from brand_shipping_invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;

  delete from brand_shipping_invoice_lines where invoice_id = inv.id;

  insert into brand_shipping_invoice_lines
    (invoice_id, order_id, order_number, customer_name, items_summary, pk_units, bd_units, weight_kg, amount_pkr)
  select inv.id, o.id, o.order_number, o.customer_name, it.summary, it.pk, it.bd,
         coalesce(w.weight_kg, 0),
         round(coalesce(w.weight_kg, 0) * v_rate * v_fx, 2)
  from orders o
  left join order_freight_weights w on w.order_id = o.id
  cross join lateral (
    select
      coalesce(sum(order_item_hub_qty(i.quantity, i.inventory_qty, i.fulfilment_origin)), 0)::int as pk,
      coalesce(sum(i.quantity - order_item_hub_qty(i.quantity, i.inventory_qty, i.fulfilment_origin)), 0)::int as bd,
      string_agg(
        case when order_item_hub_qty(i.quantity, i.inventory_qty, i.fulfilment_origin) > 0
             then order_item_hub_qty(i.quantity, i.inventory_qty, i.fulfilment_origin) || '× '
             else '' end
        || i.product_name || coalesce(' (' || i.variant || ')', '')
        || case when i.quantity > order_item_hub_qty(i.quantity, i.inventory_qty, i.fulfilment_origin)
                then ' [+' || (i.quantity - order_item_hub_qty(i.quantity, i.inventory_qty, i.fulfilment_origin))
                     || ' from BD stock, not billed]'
                else '' end,
        ', ' order by i.product_name) as summary
    from order_items i where i.order_id = o.id
  ) it
  where o.shipment_id = inv.shipment_id and o.brand_id = inv.brand_id and o.status <> 'cancelled'
  order by o.order_number;

  update brand_shipping_invoices i set
    order_count = x.n, pk_units = x.pk, bd_units = x.bd, weight_kg = x.kg, amount_pkr = x.amt,
    freight_bdt_per_kg = v_rate, fx_rate = v_fx, fx_rate_date = current_date, updated_at = now()
  from (select count(*)::int n, coalesce(sum(pk_units), 0)::int pk, coalesce(sum(bd_units), 0)::int bd,
               coalesce(sum(weight_kg), 0) kg, coalesce(sum(amount_pkr), 0) amt
        from brand_shipping_invoice_lines where invoice_id = inv.id) x
  where i.id = inv.id;
end $$;

revoke all on function _rebuild_brand_shipping_invoice(uuid) from public, anon, authenticated;

-- Recalculate all of a shipment's shipping invoices; create any missing ones.
-- Returns the number of invoices recalculated or created.
create or replace function regenerate_brand_shipping_invoices(p_shipment_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  s     shipments%rowtype;
  v_id  uuid;
  v_n   int := 0;
begin
  if not is_v360() then raise exception 'Only V360 can recalculate shipping invoices'; end if;
  select * into s from shipments where id = p_shipment_id;
  if not found then raise exception 'Shipment not found'; end if;
  if s.status < 'handed_to_carrier' then
    raise exception 'Shipping invoices are created when % is handed to the carrier', s.code;
  end if;

  for v_id in select id from brand_shipping_invoices where shipment_id = p_shipment_id loop
    perform _rebuild_brand_shipping_invoice(v_id);
    v_n := v_n + 1;
  end loop;

  return v_n + _generate_brand_shipping_invoices(p_shipment_id);
end $$;

-- Delete one brand shipping invoice.
create or replace function delete_brand_shipping_invoice(p_invoice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_v360() then raise exception 'Only V360 can delete invoices'; end if;
  delete from brand_shipping_invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
end $$;

-- Delete a saved dispatch advance / final settlement invoice. Undoes what
-- saving it did: settlement un-marks its orders and shipments as settled;
-- dispatch advance resets the shipments' advance payment status.
create or replace function delete_invoice(p_invoice_number text)
returns void language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype;
begin
  if not is_v360() then raise exception 'Only V360 can delete invoices'; end if;
  select * into inv from invoices where invoice_number = p_invoice_number for update;
  if not found then raise exception 'Invoice % not found', p_invoice_number; end if;

  if inv.invoice_type = 'final_settlement' then
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

revoke all on function delete_brand_shipping_invoice(uuid) from public, anon;
revoke all on function delete_invoice(text) from public, anon;
grant execute on function delete_brand_shipping_invoice(uuid) to authenticated;
grant execute on function delete_invoice(text) to authenticated;
