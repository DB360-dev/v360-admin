-- =====================================================================
-- ROLLBACK for migrations/055_prepaid_orders.sql
--
-- Run by hand in the Supabase SQL editor only if 055 has to be undone.
-- Kept outside supabase/migrations so `supabase db push` never runs it.
-- Restores ingest_shopify_order, kbb_account_overview, brand_payable_overview
-- and create_brand_payout_invoice, then removes the per-order money
-- functions. Order data and invoices created in the meantime are kept.
-- Revert the ops / brand portal code in git too (it reads money_* columns).
-- All-or-nothing: one transaction.
-- =====================================================================

begin;

do $$
declare r record;
begin
  if to_regclass('public.sec055_backup') is null then
    raise exception 'sec055_backup not found: 055_prepaid_orders was never applied or was already rolled back';
  end if;
  for r in select name, definition from sec055_backup order by seq loop
    if r.name = 'view:brand_payout_candidates' then
      -- 055 added columns; a view can't lose columns with create or replace.
      drop view if exists brand_payout_candidates;
      execute r.definition;
      grant select on brand_payout_candidates to authenticated;
    else
      execute r.definition;
    end if;
  end loop;
end $$;

drop function if exists _shopify_cod_due(text, jsonb, numeric);
drop function if exists money_cod_bdt(orders);
drop function if exists money_full_bdt(orders);
drop function if exists money_cod_pkr(orders);
drop function if exists money_full_pkr(orders);
drop function if exists money_is_full_cod(orders);

drop table sec055_backup;

commit;
