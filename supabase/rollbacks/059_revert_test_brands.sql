-- =====================================================================
-- ROLLBACK for migrations/059_test_brands.sql
--
-- Run by hand in the Supabase SQL editor only if 059 has to be undone.
-- Roll the ops portal back first (its Brands page reads is_test and calls
-- set_brand_test).
--
-- After this, KBB sees every order again — including the orders of brands
-- that were marked as test. Cancel or finish those first if KBB must never
-- see them. The test flag itself is deleted with the column.
--
-- kbb_account_overview and brand_payable_overview go back to the exact
-- definitions saved in test059_backup when 059 ran.
-- =====================================================================

begin;

do $$
declare r record;
begin
  if to_regclass('public.test059_backup') is null then
    raise exception 'test059_backup not found: 059_test_brands was never applied or was already rolled back';
  end if;
  for r in select name, definition from test059_backup order by seq loop
    execute r.definition;
  end loop;

  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and policyname like 'hide\_test\_%' loop
    execute format('drop policy %I on %I', r.policyname, r.tablename);
  end loop;
end $$;

drop trigger if exists orders_guard_test_shipment_mix on orders;
drop trigger if exists organizations_guard_is_test on organizations;

drop function if exists set_brand_test(uuid, boolean);
drop function if exists _guard_org_is_test();
drop function if exists _guard_test_shipment_mix();
drop function if exists _hidden_shipment_ids();
drop function if exists _hidden_order_ids();
drop function if exists _hidden_brand_ids();
drop function if exists _test_shipment_ids();
drop function if exists _is_test_brand(uuid);
drop function if exists _hides_test_data();

alter table organizations drop column if exists is_test;
drop table test059_backup;

commit;
