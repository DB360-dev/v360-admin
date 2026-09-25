-- =====================================================================
-- 028_brand_shipping_invoices.sql
--
-- 1. Hub quantity helper: the units of a line that physically travel
--    Lahore -> Dhaka (quantity minus units fulfilled from the brand's
--    Bangladesh stock; 0 for fully-BD lines).
-- 2. KBB receiving check in Bangladesh expects only those hub units, and
--    fully-BD lines don't need checking.
-- 3. Brand shipping-charges invoices: one per brand per shipment, created
--    automatically when the shipment is handed to the carrier. Weight is
--    the sum of the per-order weights recorded at hub receiving (which
--    cover Pakistan-fulfilled units only). Charge = weight x BDT/kg x FX,
--    in PKR. It is a separate bill with its own payment status; brands can
--    read their own invoices.
-- =====================================================================

alter table order_items add column if not exists inventory_qty int not null default 0
  check (inventory_qty >= 0);

create or replace function order_item_hub_qty(
  p_quantity int, p_inventory_qty int, p_origin fulfilment_origin
) returns int language sql immutable as $$
  select case when p_origin = 'bangladesh' then 0
              else greatest(0, p_quantity - coalesce(p_inventory_qty, 0)) end;
$$;

-- ---------------------------------------------------------------------
-- 2. KBB receiving check (BD) — expect hub units only
-- ---------------------------------------------------------------------

create or replace function bd_save_order_receiving(
  p_shipment_id uuid,
  p_order_id    uuid,
  p_items       jsonb
)
returns void language plpgsql security definer set search_path = public as $$
declare
  s                shipments%rowtype;
  item             jsonb;
  v_item_id        uuid;
  v_expected       int;
  v_has_discrepancy bool;
  v_order          orders%rowtype;
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Not authorised';
  end if;

  select * into s from shipments where id = p_shipment_id;
  if not found then raise exception 'Shipment not found'; end if;
  if s.status <> 'arrived_bd' then
    raise exception 'Receiving check is only available when the shipment has arrived in Bangladesh';
  end if;

  if not exists (select 1 from orders where id = p_order_id and shipment_id = p_shipment_id) then
    raise exception 'Order not in this shipment';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    v_item_id := (item->>'order_item_id')::uuid;
    select order_item_hub_qty(quantity, inventory_qty, fulfilment_origin) into v_expected
    from order_items where id = v_item_id and order_id = p_order_id;
    if not found then raise exception 'Item not found in order'; end if;
    -- Units from BD stock never travel in the shipment — nothing to check
    if v_expected = 0 then continue; end if;

    insert into bd_received_items
      (shipment_id, order_id, order_item_id, expected_qty, received_qty, note, checked_by)
    values
      (p_shipment_id, p_order_id, v_item_id, v_expected,
       coalesce((item->>'received_qty')::int, v_expected),
       nullif(trim(coalesce(item->>'note', '')), ''),
       auth.uid())
    on conflict (shipment_id, order_item_id) do update set
      expected_qty = excluded.expected_qty,
      received_qty = excluded.received_qty,
      note         = excluded.note,
      checked_at   = now(),
      checked_by   = excluded.checked_by;
  end loop;

  select exists(
    select 1 from bd_received_items
    where shipment_id = p_shipment_id
      and order_id    = p_order_id
      and received_qty <> expected_qty
  ) into v_has_discrepancy;

  select * into v_order from orders where id = p_order_id for update;

  if v_has_discrepancy then
    if v_order.status <> 'hold' and not status_is_terminal(v_order.status) then
      perform _set_order_status(
        p_order_id, 'hold',
        'Hold due to discrepancy',
        'Receiving check found mismatched quantities in shipment ' || s.code
      );
    end if;
  else
    if v_order.status = 'hold' and v_order.previous_status is not null then
      perform _set_order_status(
        p_order_id, v_order.previous_status,
        'Hold lifted — discrepancy resolved in receiving check',
        null
      );
    end if;
  end if;
end $$;

create or replace function bd_confirm_shipment_receiving(
  p_shipment_id uuid,
  p_override    boolean default false
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_unchecked   int;
  v_undisclosed int;
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Not authorised';
  end if;

  if p_override and not is_v360() then
    raise exception 'Only V360 admins can override receiving discrepancies';
  end if;

  select count(*) into v_unchecked
  from orders o
  join order_items oi on oi.order_id = o.id
  where o.shipment_id = p_shipment_id
    and order_item_hub_qty(oi.quantity, oi.inventory_qty, oi.fulfilment_origin) > 0
    and not exists (
      select 1 from bd_received_items r
      where r.shipment_id = p_shipment_id and r.order_item_id = oi.id
    );

  if v_unchecked > 0 then
    raise exception '% item(s) have not been checked yet', v_unchecked;
  end if;

  if not p_override then
    select count(*) into v_undisclosed
    from bd_received_items
    where shipment_id = p_shipment_id
      and received_qty <> expected_qty
      and (note is null or trim(note) = '');

    if v_undisclosed > 0 then
      raise exception '% discrepancy(s) need a note before confirming', v_undisclosed;
    end if;
  end if;

  perform set_shipment_status(p_shipment_id, 'received_by_partner',
    case when p_override then 'BD receiving completed with override by V360'
         else 'BD receiving check completed' end);
end $$;

-- ---------------------------------------------------------------------
-- 3. Brand shipping-charges invoices
-- ---------------------------------------------------------------------

create sequence if not exists brand_shipping_invoice_seq;

create table if not exists brand_shipping_invoices (
  id                  uuid primary key default gen_random_uuid(),
  invoice_number      text not null unique,
  shipment_id         uuid not null references shipments(id) on delete cascade,
  brand_id            uuid not null references organizations(id) on delete cascade,
  order_count         int  not null default 0,
  pk_units            int  not null default 0,   -- units billed (Pakistan-fulfilled)
  bd_units            int  not null default 0,   -- units from BD stock (shown, not billed)
  weight_kg           numeric(10,2) not null default 0,
  freight_bdt_per_kg  numeric(12,2) not null,
  fx_rate             numeric(18,6) not null,
  fx_rate_date        date not null,
  amount_pkr          numeric(14,2) not null default 0,
  payment_status      invoice_payment_status not null default 'not_paid',
  paid_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (shipment_id, brand_id)
);
create index if not exists brand_shipping_invoices_brand_idx on brand_shipping_invoices (brand_id);

create table if not exists brand_shipping_invoice_lines (
  id             bigserial primary key,
  invoice_id     uuid not null references brand_shipping_invoices(id) on delete cascade,
  order_id       uuid not null references orders(id) on delete cascade,
  order_number   text not null,
  customer_name  text,
  items_summary  text,          -- e.g. "3× Snowboard (+2 from BD stock)"
  pk_units       int  not null default 0,
  bd_units       int  not null default 0,
  weight_kg      numeric(10,2) not null default 0,
  amount_pkr     numeric(14,2) not null default 0
);
create index if not exists brand_shipping_invoice_lines_invoice_idx on brand_shipping_invoice_lines (invoice_id);

alter table brand_shipping_invoices enable row level security;
alter table brand_shipping_invoice_lines enable row level security;

drop policy if exists brand_shipping_invoices_read on brand_shipping_invoices;
create policy brand_shipping_invoices_read on brand_shipping_invoices for select to authenticated
  using (is_v360() or is_brand_member(brand_id));

drop policy if exists brand_shipping_invoice_lines_read on brand_shipping_invoice_lines;
create policy brand_shipping_invoice_lines_read on brand_shipping_invoice_lines for select to authenticated
  using (exists (select 1 from brand_shipping_invoices i where i.id = invoice_id));

grant select on brand_shipping_invoices, brand_shipping_invoice_lines to authenticated;

-- Builds the invoices for every brand on a shipment that doesn't have one
-- yet. Internal — called by the dispatch trigger and the regenerate RPC.
create or replace function _generate_brand_shipping_invoices(p_shipment_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_rate    numeric := (select freight_bdt_per_kg from money_settings where id = 1);
  v_fx      numeric := fx_rate_pkr('BDT', current_date);
  v_brand   uuid;
  v_inv     uuid;
  v_created int := 0;
begin
  if v_rate is null then
    raise exception 'Set the BDT freight rate per kg in Money settings before dispatching';
  end if;

  for v_brand in
    select distinct o.brand_id from orders o
    where o.shipment_id = p_shipment_id and o.status <> 'cancelled'
      and not exists (select 1 from brand_shipping_invoices i
                      where i.shipment_id = p_shipment_id and i.brand_id = o.brand_id)
  loop
    insert into brand_shipping_invoices
      (invoice_number, shipment_id, brand_id, freight_bdt_per_kg, fx_rate, fx_rate_date)
    values
      ('FRT-' || lpad(nextval('brand_shipping_invoice_seq')::text, 5, '0'),
       p_shipment_id, v_brand, v_rate, v_fx, current_date)
    returning id into v_inv;

    insert into brand_shipping_invoice_lines
      (invoice_id, order_id, order_number, customer_name, items_summary, pk_units, bd_units, weight_kg, amount_pkr)
    select v_inv, o.id, o.order_number, o.customer_name, it.summary, it.pk, it.bd,
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
    where o.shipment_id = p_shipment_id and o.brand_id = v_brand and o.status <> 'cancelled'
    order by o.order_number;

    update brand_shipping_invoices i set
      order_count = x.n, pk_units = x.pk, bd_units = x.bd, weight_kg = x.kg, amount_pkr = x.amt
    from (select count(*)::int n, coalesce(sum(pk_units), 0)::int pk, coalesce(sum(bd_units), 0)::int bd,
                 coalesce(sum(weight_kg), 0) kg, coalesce(sum(amount_pkr), 0) amt
          from brand_shipping_invoice_lines where invoice_id = v_inv) x
    where i.id = v_inv;

    v_created := v_created + 1;
  end loop;

  return v_created;
end $$;

revoke all on function _generate_brand_shipping_invoices(uuid) from public, anon, authenticated;

-- Auto-create when a shipment is handed to the carrier.
create or replace function _shipments_generate_shipping_invoices()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status < 'handed_to_carrier' and new.status >= 'handed_to_carrier' then
    perform _generate_brand_shipping_invoices(new.id);
  end if;
  return new;
end $$;

drop trigger if exists shipments_generate_shipping_invoices on shipments;
create trigger shipments_generate_shipping_invoices
  after update of status on shipments
  for each row execute function _shipments_generate_shipping_invoices();

-- V360: rebuild a shipment's unpaid shipping invoices (e.g. after a weight
-- was corrected). Paid / partially paid invoices are left untouched.
create or replace function regenerate_brand_shipping_invoices(p_shipment_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare s shipments%rowtype;
begin
  if not is_v360() then raise exception 'Only V360 can regenerate shipping invoices'; end if;
  select * into s from shipments where id = p_shipment_id;
  if not found then raise exception 'Shipment not found'; end if;
  if s.status < 'handed_to_carrier' then
    raise exception 'Shipping invoices are created when % is handed to the carrier', s.code;
  end if;
  delete from brand_shipping_invoices where shipment_id = p_shipment_id and payment_status = 'not_paid';
  return _generate_brand_shipping_invoices(p_shipment_id);
end $$;

create or replace function set_brand_shipping_invoice_payment_status(
  p_invoice_id uuid, p_status invoice_payment_status
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_v360() then raise exception 'Only V360 can change invoice payment status'; end if;
  update brand_shipping_invoices set
    payment_status = p_status,
    paid_at    = case when p_status = 'paid' then coalesce(paid_at, now()) else null end,
    updated_at = now()
  where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
end $$;

revoke all on function regenerate_brand_shipping_invoices(uuid) from public, anon;
revoke all on function set_brand_shipping_invoice_payment_status(uuid, invoice_payment_status) from public, anon;
grant execute on function regenerate_brand_shipping_invoices(uuid) to authenticated;
grant execute on function set_brand_shipping_invoice_payment_status(uuid, invoice_payment_status) to authenticated;
