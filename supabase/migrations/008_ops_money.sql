-- =====================================================================
-- 008_ops_money.sql — Money feature for the Admin panel (V360 + KBB).
-- Brand payables, statements/settlements, the KBB running account,
-- freight weights, and the commission / FX settings behind them.
--
-- Money model (example, one order of 10,000 BDT incl. shipping):
--   KBB commission   (kept by KBB from COD)  = base × kbb_commission_pct%
--   KBB owes V360                            = base − KBB commission
--       paid at dispatch (50%)               -> dispatch advance
--       paid on delivery (50%)               -> delivery balance
--   V360 commission (from the brand)         = order_total × v360_commission_pct%
--   Brand receives                           = order_total − V360 commission − freight
--   V360 gross margin                        = (KBB owes) − (brand receives), before freight
--
-- All reported amounts are converted to PKR via fx_rates (BDT->PKR etc.).
-- =====================================================================

-- ---------- Enums ----------------------------------------------------

create type settlement_kind   as enum ('monthly', 'manual');
create type settlement_status as enum ('issued', 'paid');
create type kbb_payment_kind  as enum ('dispatch_advance', 'delivery_balance', 'credit');

-- ---------- Commission / freight settings ----------------------------
-- Single-row table. Read via my_money_settings(); written via update_money_settings().

create table money_settings (
  id                    int primary key default 1 check (id = 1),
  kbb_commission_pct    numeric(5,2) not null default 8,
  v360_commission_pct   numeric(5,2) not null default 15,
  freight_bdt_per_kg    numeric(12,2),
  invoice_company_name  text
);

insert into money_settings (id) values (1) on conflict do nothing;

-- ---------- Freight weights ------------------------------------------
-- Per brand, per shipment: that brand's weight on the shipment, with the
-- freight rate and FX rate snapshot at the time it was entered.

create table shipment_brand_weights (
  id                  bigserial primary key,
  shipment_id         uuid not null references shipments(id) on delete cascade,
  brand_id            uuid not null references organizations(id) on delete cascade,
  weight_kg           numeric(10,2) not null check (weight_kg >= 0),
  freight_bdt_per_kg  numeric(12,2) not null,
  fx_rate             numeric(18,6) not null,
  fx_rate_date        date not null default current_date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (shipment_id, brand_id)
);
create index on shipment_brand_weights (brand_id);

-- Optional per-order parcel weight (same snapshot columns). When present
-- it overrides the even "split across a brand's orders" default.

create table order_freight_weights (
  order_id            uuid primary key references orders(id) on delete cascade,
  weight_kg           numeric(10,2) not null check (weight_kg >= 0),
  freight_bdt_per_kg  numeric(12,2) not null,
  fx_rate             numeric(18,6) not null,
  fx_rate_date        date not null default current_date,
  updated_at          timestamptz not null default now()
);

-- ---------- KBB payments ---------------------------------------------
-- Dispatch advances attach to a shipment; delivery balances and credits
-- attach to one order. amount / currency are what was actually paid;
-- fx_rate and amount_pkr are the PKR conversion at the payment date.

create table kbb_payments (
  id              bigserial primary key,
  kind            kbb_payment_kind not null,
  shipment_id     uuid references shipments(id) on delete set null,
  order_id        uuid references orders(id) on delete set null,
  amount          numeric(14,2) not null check (amount > 0),
  currency        text not null default 'PKR',
  fx_rate         numeric(18,6) not null default 1,
  amount_pkr      numeric(14,2) not null check (amount_pkr > 0),
  payment_date    date not null,
  note            text,
  recorded_by     uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  check (kind = 'dispatch_advance' or order_id is not null)
);
create index on kbb_payments (shipment_id);
create index on kbb_payments (order_id);

-- ---------- Statements / settlements ---------------------------------

create table settlements (
  id                  bigserial primary key,
  brand_id            uuid not null references organizations(id) on delete cascade,
  kind                settlement_kind not null,
  period_start        date,
  period_end          date,
  status              settlement_status not null default 'issued',
  order_count         int not null default 0,
  total_order_total   numeric(14,2) not null default 0,
  total_commission    numeric(14,2) not null default 0,
  total_freight       numeric(14,2) not null default 0,
  total_payable       numeric(14,2) not null default 0,
  commission_pct      numeric(5,2) not null,
  note                text,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);
create index on settlements (brand_id, status);

create table settlement_lines (
  id                  bigserial primary key,
  settlement_id       bigint not null references settlements(id) on delete cascade,
  order_id            uuid not null references orders(id) on delete cascade,
  order_number        text not null,
  order_total         numeric(14,2) not null,          -- order_total in PKR
  commission          numeric(14,2) not null,          -- V360 commission in PKR
  freight_share_pkr   numeric(14,2) not null default 0,
  freight_fx_rate     numeric(18,6),
  freight_rate_date   date,
  brand_payable       numeric(14,2) not null,          -- order_total − commission − freight
  delivered_at        timestamptz not null,
  unique (order_id)
);
create index on settlement_lines (settlement_id);

-- ---------- FX / money helpers ---------------------------------------

-- FX rate for `currency` -> PKR on or before `on_date`; falls back to the
-- latest known rate, then 1.
create function fx_rate_pkr(currency text, on_date date)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (select rate from fx_rates
      where base = upper(currency) and quote = 'PKR' and rate_date <= on_date
      order by rate_date desc limit 1),
    (select rate from fx_rates
      where base = upper(currency) and quote = 'PKR'
      order by rate_date desc limit 1),
    1);
$$;

create function fx_convert(amount numeric, currency text, on_date date)
returns numeric language sql stable security definer set search_path = public as $$
  select round(coalesce(amount, 0) * fx_rate_pkr(currency, on_date), 2);
$$;

-- PKR freight for one order: uses the per-order weight if one was entered,
-- otherwise splits the brand's shipment weight evenly across its orders.
create function order_freight_share_pkr(p_order_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(coalesce((
    select (ofw.weight_kg * ofw.freight_bdt_per_kg * ofw.fx_rate)
    from order_freight_weights ofw where ofw.order_id = p_order_id
  ), (
    select sw.weight_kg * sw.freight_bdt_per_kg * sw.fx_rate
      / nullif((select count(*) from orders o2
                where o2.shipment_id = o.shipment_id and o2.brand_id = o.brand_id), 0)
    from orders o
    join shipment_brand_weights sw on sw.shipment_id = o.shipment_id and sw.brand_id = o.brand_id
    where o.id = p_order_id
  ), 0), 2);
$$;

-- ---------- Settings: read + write -----------------------------------

-- Single settings row as JSON so the panel can read whichever keys its
-- role is allowed to see.
create function my_money_settings()
returns json language plpgsql stable security definer set search_path = public as $$
declare v json;
begin
  if auth.uid() is null then return null; end if;
  select to_jsonb(m) from money_settings m limit 1 into v;
  return v;
end $$;

create function update_money_settings(
  p_kbb_commission_pct    numeric,
  p_v360_commission_pct   numeric,
  p_freight_bdt_per_kg    numeric,
  p_invoice_company_name  text
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_v360() then
    raise exception 'Only V360 can change money settings';
  end if;
  if p_kbb_commission_pct < 0 or p_kbb_commission_pct >= 100
     or p_v360_commission_pct < 0 or p_v360_commission_pct >= 100 then
    raise exception 'Commission percentages must be 0 to just under 100';
  end if;
  if p_freight_bdt_per_kg < 0 then
    raise exception 'Freight rate cannot be negative';
  end if;
  update money_settings set
    kbb_commission_pct   = p_kbb_commission_pct,
    v360_commission_pct  = p_v360_commission_pct,
    freight_bdt_per_kg   = p_freight_bdt_per_kg,
    invoice_company_name = nullif(trim(p_invoice_company_name), '')
  where id = 1;
  if not found then
    insert into money_settings (id, kbb_commission_pct, v360_commission_pct, freight_bdt_per_kg, invoice_company_name)
    values (1, p_kbb_commission_pct, p_v360_commission_pct, p_freight_bdt_per_kg, nullif(trim(p_invoice_company_name), ''));
  end if;
end $$;

-- ---------- Freight weight entry -------------------------------------

create function set_shipment_brand_weight(
  p_shipment_id uuid,
  p_brand_id    uuid,
  p_weight_kg   numeric
)
returns void language plpgsql security definer set search_path = public as $$
declare v_rate numeric := (select freight_bdt_per_kg from money_settings where id = 1);
begin
  if not is_v360() then raise exception 'Only V360 can enter freight weights'; end if;
  if p_weight_kg is null then
    delete from shipment_brand_weights
      where shipment_id = p_shipment_id and brand_id = p_brand_id;
    return;
  end if;
  if p_weight_kg < 0 then raise exception 'Weight must be 0 kg or more'; end if;
  if v_rate is null then
    raise exception 'Set the BDT freight rate per kg in Money settings first';
  end if;
  insert into shipment_brand_weights
    (shipment_id, brand_id, weight_kg, freight_bdt_per_kg, fx_rate, fx_rate_date, updated_at)
  values
    (p_shipment_id, p_brand_id, p_weight_kg, v_rate, fx_rate_pkr('BDT', current_date), current_date, now())
  on conflict (shipment_id, brand_id) do update set
    weight_kg          = excluded.weight_kg,
    freight_bdt_per_kg = excluded.freight_bdt_per_kg,
    fx_rate            = excluded.fx_rate,
    fx_rate_date       = excluded.fx_rate_date,
    updated_at         = now();
end $$;

create function set_order_freight_weight(
  p_order_id  uuid,
  p_weight_kg numeric
)
returns void language plpgsql security definer set search_path = public as $$
declare v_rate numeric := (select freight_bdt_per_kg from money_settings where id = 1);
begin
  if not is_v360() then raise exception 'Only V360 can enter freight weights'; end if;
  if p_weight_kg is null then
    delete from order_freight_weights where order_id = p_order_id;
    return;
  end if;
  if p_weight_kg < 0 then raise exception 'Weight must be 0 kg or more'; end if;
  if v_rate is null then
    raise exception 'Set the BDT freight rate per kg in Money settings first';
  end if;
  insert into order_freight_weights (order_id, weight_kg, freight_bdt_per_kg, fx_rate, fx_rate_date, updated_at)
  values (p_order_id, p_weight_kg, v_rate, fx_rate_pkr('BDT', current_date), current_date, now())
  on conflict (order_id) do update set
    weight_kg          = excluded.weight_kg,
    freight_bdt_per_kg = excluded.freight_bdt_per_kg,
    fx_rate            = excluded.fx_rate,
    fx_rate_date       = excluded.fx_rate_date,
    updated_at         = now();
end $$;

-- ---------- Brand payables overview ----------------------------------

create function brand_payable_overview()
returns table (
  brand_id       uuid,
  brand_name     text,
  order_count    bigint,
  order_total_sum numeric,
  commission_sum numeric,
  freight_sum    numeric,
  payable_sum    numeric
) language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_v360() or is_partner()) then return; end if;
  return query
    select
      o.brand_id,
      b.name                                                   as brand_name,
      count(*)::bigint                                         as order_count,
      round(sum(fx_convert(o.order_total, o.currency, o.delivered_at::date)), 2) as order_total_sum,
      round(sum(fx_convert(o.order_total, o.currency, o.delivered_at::date)
                * (select v360_commission_pct from money_settings where id = 1) / 100), 2) as commission_sum,
      round(coalesce(sum(order_freight_share_pkr(o.id)), 0), 2) as freight_sum,
      round(sum(fx_convert(o.order_total, o.currency, o.delivered_at::date)
                * (1 - (select v360_commission_pct from money_settings where id = 1) / 100))
            - coalesce(sum(order_freight_share_pkr(o.id)), 0), 2) as payable_sum
    from orders o
    join organizations b on b.id = o.brand_id
    where o.status = 'delivered'
      and not exists (select 1 from settlement_lines sl where sl.order_id = o.id)
    group by o.brand_id, b.name
    order by b.name;
end $$;

-- ---------- KBB running account overview -----------------------------
-- One row per order on a dispatched shipment. Dispatch advances are paid
-- per shipment, so they are apportioned to each order by its share of the
-- shipment's order value; whole-shipment credits are apportioned the same
-- way. Delivery payments attach to a single order.

create or replace function kbb_account_overview()
returns table (
  order_id        uuid,
  order_number    text,
  shipment_id     uuid,
  shipment_code   text,
  shipment_status shipment_status,
  order_date      timestamptz,
  order_value_pkr numeric,
  advance_owed    numeric,
  advance_paid    numeric,
  delivery_owed   numeric,
  delivery_paid   numeric,
  credits         numeric,
  net_balance     numeric
) language plpgsql stable security definer set search_path = public as $$
declare v_pct_kbb numeric;
begin
  if not (is_v360() or is_partner()) then return; end if;

  select kbb_commission_pct / 100 into v_pct_kbb from money_settings where id = 1;
  v_pct_kbb := coalesce(v_pct_kbb, 0.08);

  return query
  with base as (
    select
      o.id, o.order_number, o.shipment_id,
      s.code as shipment_code, s.status as shipment_status, o.order_date,
      fx_convert(coalesce(o.cod_amount_expected, o.order_total),
                 coalesce(o.cod_currency, o.currency), o.order_date::date) as order_value_pkr
    from orders o
    join shipments s on s.id = o.shipment_id
    where s.status >= 'handed_to_carrier'
  ),
  pay as (
    select
      b.*,
      b.order_value_pkr * (1 - v_pct_kbb) as owes_pkr,
      sum(b.order_value_pkr) over (partition by b.shipment_id) as ship_value,
      (select coalesce(sum(k.amount_pkr), 0) from kbb_payments k
        where k.kind = 'dispatch_advance' and k.shipment_id = b.shipment_id) as ship_adv_paid,
      (select coalesce(sum(k.amount_pkr), 0) from kbb_payments k
        where k.kind = 'delivery_balance' and k.order_id = b.id) as del_paid,
      (select coalesce(sum(k.amount_pkr), 0) from kbb_payments k
        where k.kind = 'credit'
          and (k.order_id = b.id
               or (k.shipment_id = b.shipment_id and k.order_id is null))) as credits
    from base b
  )
  select
    p.id,
    p.order_number,
    p.shipment_id,
    p.shipment_code,
    p.shipment_status,
    p.order_date,
    round(p.order_value_pkr, 2)                                          as order_value_pkr,
    round(0.5 * p.owes_pkr, 2)                                           as advance_owed,
    round(0.5 * p.ship_adv_paid * p.order_value_pkr / nullif(p.ship_value, 0), 2) as advance_paid,
    round(0.5 * p.owes_pkr, 2)                                           as delivery_owed,
    round(p.del_paid, 2)                                                 as delivery_paid,
    round(p.credits, 2)                                                  as credits,
    round(p.owes_pkr
          - 0.5 * p.ship_adv_paid * p.order_value_pkr / nullif(p.ship_value, 0)
          - p.del_paid - p.credits, 2)                                   as net_balance
  from pay p
  order by p.order_date desc, p.shipment_code;
end $$;

-- ---------- Record a KBB payment -------------------------------------

create function record_kbb_payment(
  p_kind          text,
  p_amount        numeric,
  p_currency      text,
  p_payment_date  date,
  p_shipment_id   uuid,
  p_order_id      uuid,
  p_note          text
)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_fx numeric;
begin
  if not is_v360() then raise exception 'Only V360 can record payments'; end if;
  if p_kind not in ('dispatch_advance', 'delivery_balance', 'credit') then
    raise exception 'Unknown payment type';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if upper(p_currency) = 'PKR' then
    v_fx := 1;
  else
    v_fx := fx_rate_pkr(p_currency, p_payment_date);
  end if;

  insert into kbb_payments
    (kind, shipment_id, order_id, amount, currency, fx_rate, amount_pkr, payment_date, note, recorded_by)
  values
    (p_kind::kbb_payment_kind, p_shipment_id, p_order_id, p_amount, upper(p_currency),
     v_fx, round(p_amount * v_fx, 2), p_payment_date, nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- ---------- Create a statement (settlement) --------------------------

create function create_brand_settlement(
  p_brand_id     uuid,
  p_period_start date,
  p_period_end   date
)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id    bigint;
  v_pct   numeric;
  v_total_order_total numeric := 0;
  v_total_commission  numeric := 0;
  v_total_freight     numeric := 0;
  v_total_payable     numeric := 0;
  v_count int := 0;
  r record;
begin
  if not is_v360() then raise exception 'Only V360 can create statements'; end if;
  select v360_commission_pct into v_pct from money_settings where id = 1;
  if v_pct is null then raise exception 'Set the V360 commission in Money settings first'; end if;

  for r in
    select o.id, o.order_number, o.delivered_at,
           fx_convert(o.order_total, o.currency, o.delivered_at::date) as order_total_pkr,
           order_freight_share_pkr(o.id) as freight_pkr
    from orders o
    where o.status = 'delivered'
      and o.brand_id = p_brand_id
      and not exists (select 1 from settlement_lines sl where sl.order_id = o.id)
      and (p_period_start is null or o.delivered_at::date >= p_period_start)
      and (p_period_end   is null or o.delivered_at::date <= p_period_end)
    order by o.delivered_at
  loop
    v_count := v_count + 1;
    v_total_order_total := v_total_order_total + r.order_total_pkr;
    v_total_commission  := v_total_commission  + round(r.order_total_pkr * v_pct / 100, 2);
    v_total_freight     := v_total_freight     + coalesce(r.freight_pkr, 0);
    v_total_payable     := v_total_payable
                           + r.order_total_pkr
                           - round(r.order_total_pkr * v_pct / 100, 2)
                           - coalesce(r.freight_pkr, 0);
  end loop;

  if v_count = 0 then
    raise exception 'No delivered orders to settle for this brand/period';
  end if;

  insert into settlements
    (brand_id, kind, period_start, period_end, status, order_count,
     total_order_total, total_commission, total_freight, total_payable, commission_pct, created_by)
  values
    (p_brand_id,
     case when p_period_start is null then 'manual' else 'monthly' end,
     p_period_start, p_period_end, 'issued', v_count,
     v_total_order_total, v_total_commission, v_total_freight, v_total_payable, v_pct, auth.uid())
  returning id into v_id;

  for r in
    select o.id, o.order_number, o.delivered_at,
           fx_convert(o.order_total, o.currency, o.delivered_at::date) as order_total_pkr,
           order_freight_share_pkr(o.id) as freight_pkr,
           (select fx_rate     from order_freight_weights ofw where ofw.order_id = o.id) as f_fx,
           (select fx_rate_date from order_freight_weights ofw where ofw.order_id = o.id) as f_date,
           (select fx_rate     from shipment_brand_weights sw
             where sw.shipment_id = o.shipment_id and sw.brand_id = o.brand_id) as s_fx,
           (select fx_rate_date from shipment_brand_weights sw
             where sw.shipment_id = o.shipment_id and sw.brand_id = o.brand_id) as s_date
    from orders o
    where o.status = 'delivered'
      and o.brand_id = p_brand_id
      and not exists (select 1 from settlement_lines sl where sl.order_id = o.id)
      and (p_period_start is null or o.delivered_at::date >= p_period_start)
      and (p_period_end   is null or o.delivered_at::date <= p_period_end)
    order by o.delivered_at
  loop
    insert into settlement_lines
      (settlement_id, order_id, order_number, order_total, commission, freight_share_pkr,
       freight_fx_rate, freight_rate_date, brand_payable, delivered_at)
    values
      (v_id, r.id, r.order_number, r.order_total_pkr, round(r.order_total_pkr * v_pct / 100, 2),
       coalesce(r.freight_pkr, 0), coalesce(r.f_fx, r.s_fx), coalesce(r.f_date, r.s_date),
       r.order_total_pkr - round(r.order_total_pkr * v_pct / 100, 2) - coalesce(r.freight_pkr, 0),
       r.delivered_at);
  end loop;

  return v_id;
end $$;

-- ---------- Mark a statement as paid ---------------------------------

create function mark_settlement_paid(p_settlement_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_v360() then raise exception 'Only V360 can mark statements as paid'; end if;
  update settlements set status = 'paid', paid_at = now()
    where id = p_settlement_id and status <> 'paid';
end $$;

-- ---------- Privileges & RLS ----------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

grant select on money_settings, shipment_brand_weights, order_freight_weights,
  kbb_payments, settlements, settlement_lines to authenticated;
grant usage on sequence
  shipment_brand_weights_id_seq,
  kbb_payments_id_seq, settlements_id_seq, settlement_lines_id_seq to authenticated;

revoke execute on function
  fx_rate_pkr(text, date), fx_convert(numeric, text, date), order_freight_share_pkr(uuid),
  my_money_settings(), update_money_settings(numeric, numeric, numeric, text),
  set_shipment_brand_weight(uuid, uuid, numeric), set_order_freight_weight(uuid, numeric),
  brand_payable_overview(), kbb_account_overview(),
  record_kbb_payment(text, numeric, text, date, uuid, uuid, text),
  create_brand_settlement(uuid, date, date), mark_settlement_paid(bigint)
from public, anon;
grant execute on function
  fx_rate_pkr(text, date), fx_convert(numeric, text, date), order_freight_share_pkr(uuid),
  my_money_settings(), update_money_settings(numeric, numeric, numeric, text),
  set_shipment_brand_weight(uuid, uuid, numeric), set_order_freight_weight(uuid, numeric),
  brand_payable_overview(), kbb_account_overview(),
  record_kbb_payment(text, numeric, text, date, uuid, uuid, text),
  create_brand_settlement(uuid, date, date), mark_settlement_paid(bigint)
to authenticated;

alter table money_settings          enable row level security;
alter table shipment_brand_weights  enable row level security;
alter table order_freight_weights   enable row level security;
alter table kbb_payments            enable row level security;
alter table settlements             enable row level security;
alter table settlement_lines        enable row level security;

create policy money_settings_read on money_settings for select to authenticated using (true);

create policy weight_read on shipment_brand_weights for select to authenticated
  using (is_v360() or is_partner()
         or exists (select 1 from shipments s join orders o on o.shipment_id = s.id
                    where s.id = shipment_id and is_brand_member(o.brand_id)));
create policy order_weight_read on order_freight_weights for select to authenticated
  using (is_v360() or is_partner()
         or exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)));

create policy kbb_payments_read on kbb_payments for select to authenticated
  using (is_v360() or is_partner());

create policy settlements_read on settlements for select to authenticated
  using (is_v360() or is_partner());
create policy settlement_lines_read on settlement_lines for select to authenticated
  using (is_v360() or is_partner());