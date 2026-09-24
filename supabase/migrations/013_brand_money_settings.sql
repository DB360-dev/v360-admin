-- =====================================================================
-- 013_brand_money_settings.sql — Per-brand commission and freight settings
-- Stores custom KBB commission %, V360 commission %, freight BDT/kg rate,
-- and invoice company name for each brand.
-- Used when generating brand statements, payables, and invoices.
-- =====================================================================

create table if not exists brand_money_settings (
  brand_id              uuid primary key references organizations(id) on delete cascade,
  kbb_commission_pct    numeric(5,2) not null default 8,
  v360_commission_pct   numeric(5,2) not null default 15,
  freight_bdt_per_kg    numeric(12,2) not null default 700,
  invoice_company_name  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Enable RLS
alter table brand_money_settings enable row level security;

-- RLS Policies
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'V360 full access on brand_money_settings') then
    create policy "V360 full access on brand_money_settings" on brand_money_settings
      for all using (is_v360());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Brands read own brand_money_settings') then
    create policy "Brands read own brand_money_settings" on brand_money_settings
      for select using (actor_group_for(brand_id) = 'brand');
  end if;
end $$;

-- Update approve_brand function to take brand money settings
create or replace function approve_brand(
  p_org_id              uuid,
  p_note                text default null,
  p_kbb_commission_pct  numeric default 8,
  p_v360_commission_pct numeric default 15,
  p_freight_bdt_per_kg  numeric default 700,
  p_invoice_company_name text default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_v360_admin() then raise exception 'Only V360 admins can approve brands'; end if;

  update organizations set
    is_active = true,
    approval_status = 'approved',
    reviewed_at = now(),
    review_note = p_note
  where id = p_org_id and type = 'brand';

  if not found then raise exception 'Brand not found'; end if;

  insert into brand_money_settings (
    brand_id,
    kbb_commission_pct,
    v360_commission_pct,
    freight_bdt_per_kg,
    invoice_company_name,
    updated_at
  )
  values (
    p_org_id,
    coalesce(p_kbb_commission_pct, 8),
    coalesce(p_v360_commission_pct, 15),
    coalesce(p_freight_bdt_per_kg, 700),
    nullif(trim(p_invoice_company_name), ''),
    now()
  )
  on conflict (brand_id) do update set
    kbb_commission_pct   = excluded.kbb_commission_pct,
    v360_commission_pct  = excluded.v360_commission_pct,
    freight_bdt_per_kg   = excluded.freight_bdt_per_kg,
    invoice_company_name = excluded.invoice_company_name,
    updated_at           = now();
end $$;

-- RPC to get settings for a brand (with fallback to global money_settings)
create or replace function get_brand_money_settings(p_brand_id uuid)
returns table (
  brand_id              uuid,
  kbb_commission_pct    numeric,
  v360_commission_pct   numeric,
  freight_bdt_per_kg    numeric,
  invoice_company_name  text
)
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from brand_money_settings b where b.brand_id = p_brand_id) then
    return query
    select
      b.brand_id,
      b.kbb_commission_pct,
      b.v360_commission_pct,
      b.freight_bdt_per_kg,
      b.invoice_company_name
    from brand_money_settings b
    where b.brand_id = p_brand_id;
  else
    return query
    select
      p_brand_id as brand_id,
      m.kbb_commission_pct,
      m.v360_commission_pct,
      coalesce(m.freight_bdt_per_kg, 700) as freight_bdt_per_kg,
      m.invoice_company_name
    from money_settings m
    where m.id = 1;
  end if;
end $$;

-- RPC to update/save settings for a brand
create or replace function save_brand_money_settings(
  p_brand_id            uuid,
  p_kbb_commission_pct  numeric,
  p_v360_commission_pct numeric,
  p_freight_bdt_per_kg  numeric,
  p_invoice_company_name text default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_v360_admin() then raise exception 'Only V360 admins can update brand settings'; end if;

  insert into brand_money_settings (
    brand_id,
    kbb_commission_pct,
    v360_commission_pct,
    freight_bdt_per_kg,
    invoice_company_name,
    updated_at
  )
  values (
    p_brand_id,
    coalesce(p_kbb_commission_pct, 8),
    coalesce(p_v360_commission_pct, 15),
    coalesce(p_freight_bdt_per_kg, 700),
    nullif(trim(p_invoice_company_name), ''),
    now()
  )
  on conflict (brand_id) do update set
    kbb_commission_pct   = excluded.kbb_commission_pct,
    v360_commission_pct  = excluded.v360_commission_pct,
    freight_bdt_per_kg   = excluded.freight_bdt_per_kg,
    invoice_company_name = excluded.invoice_company_name,
    updated_at           = now();
end $$;

-- Grant execution to authenticated users
grant execute on function approve_brand(uuid, text, numeric, numeric, numeric, text) to authenticated;
grant execute on function get_brand_money_settings(uuid) to authenticated;
grant execute on function save_brand_money_settings(uuid, numeric, numeric, numeric, text) to authenticated;

-- Update brand_payable_overview to use brand specific settings
create or replace function brand_payable_overview()
returns table (
  brand_id        uuid,
  brand_name      text,
  order_count     bigint,
  order_total_sum numeric,
  commission_sum  numeric,
  freight_sum     numeric,
  payable_sum     numeric
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
                * coalesce(bms.v360_commission_pct, ms.v360_commission_pct) / 100), 2) as commission_sum,
      round(coalesce(sum(order_freight_share_pkr(o.id)), 0), 2) as freight_sum,
      round(sum(fx_convert(o.order_total, o.currency, o.delivered_at::date)
                * (1 - coalesce(bms.v360_commission_pct, ms.v360_commission_pct) / 100))
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

-- Update create_brand_settlement to use brand specific settings
create or replace function create_brand_settlement(
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

  select coalesce(bms.v360_commission_pct, ms.v360_commission_pct) into v_pct
  from money_settings ms
  left join brand_money_settings bms on bms.brand_id = p_brand_id
  where ms.id = 1;

  if v_pct is null then v_pct := 15; end if;

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
      (settlement_id, order_id, order_number, order_total, commission,
       freight_share_pkr, freight_fx_rate, freight_rate_date, brand_payable, delivered_at)
    values
      (v_id, r.id, r.order_number, r.order_total_pkr,
       round(r.order_total_pkr * v_pct / 100, 2),
       coalesce(r.freight_pkr, 0),
       coalesce(r.f_fx, r.s_fx),
       coalesce(r.f_date, r.s_date),
       round(r.order_total_pkr * (1 - v_pct / 100) - coalesce(r.freight_pkr, 0), 2),
       r.delivered_at);
  end loop;

  return v_id;
end $$;
