-- =====================================================================
-- ROLLBACK for migrations/061_order_overview_brand_confirmed_at.sql
--
-- Run by hand in the Supabase SQL editor only if 061 has to be undone.
-- Puts order_overview back exactly as it was before 061. Roll the ops
-- portal back too, or the All orders list will fail to load.
-- Fails (and changes nothing) if another view depends on order_overview.
-- =====================================================================

begin;

do $$
declare v_def text;
begin
  if to_regclass('public.fix061_backup') is null then
    raise exception 'fix061_backup not found: 061 was never applied or was already rolled back';
  end if;
  select definition into v_def from fix061_backup limit 1;
  if v_def is null then
    raise exception 'fix061_backup is empty: 061 found the column already there, so there is nothing to undo';
  end if;
  drop view order_overview;
  execute 'create view order_overview with (security_invoker = true) as ' || v_def;
end $$;

grant select on order_overview to authenticated;
drop table fix061_backup;

commit;
