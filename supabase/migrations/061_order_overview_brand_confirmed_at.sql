-- =====================================================================
-- 061_order_overview_brand_confirmed_at.sql
--
-- Problem: the ops portal's All orders list could only guess the brand
-- column from the status. An order KBB confirmed straight from New
-- (status `confirmed`, brand never confirmed) showed as "Confirmed" in the
-- Brand status column, while the order page (which reads
-- orders.brand_confirmed_at) said "Not confirmed by brand yet".
--
-- Fix: expose orders.brand_confirmed_at on order_overview. The live view
-- differs from the repo, so the column is appended to its current
-- definition (as in 034); nothing else in the view changes. No data changes.
--
-- Rollback: supabase/rollbacks/061_revert_order_overview_brand_confirmed_at.sql
-- =====================================================================

begin;

create table if not exists fix061_backup (definition text not null);
alter table fix061_backup enable row level security;
revoke all on fix061_backup from anon, authenticated;

do $$
declare
  v_def text := pg_get_viewdef('order_overview'::regclass, true);
  v_pos int;
begin
  if v_def ~ 'brand_confirmed_at' then
    raise notice 'order_overview already has brand_confirmed_at; nothing to do';
    return;
  end if;
  insert into fix061_backup (definition) values (v_def);
  v_pos := strpos(v_def, E'\n   FROM ');
  if v_pos = 0 then
    raise exception 'order_overview: could not find its FROM clause. Definition: %', v_def;
  end if;
  execute 'create or replace view order_overview with (security_invoker = true) as '
    || substr(v_def, 1, v_pos - 1) || E',\n    o.brand_confirmed_at' || substr(v_def, v_pos);
end $$;

grant select on order_overview to authenticated;

commit;
