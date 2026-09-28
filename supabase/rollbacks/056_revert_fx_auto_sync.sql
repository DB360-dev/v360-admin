-- =====================================================================
-- ROLLBACK for migrations/056_fx_auto_sync.sql
--
-- Run by hand in the Supabase SQL editor only if 056 has to be undone.
-- Stops the schedule and removes sync_fx_rates(). Rates already fetched stay
-- in fx_rates (past conversions keep using them); delete them by hand with
--   delete from fx_rates where note like 'Auto:%';
-- only if you really want them gone. The http / pg_cron extensions are left
-- installed (other features use http).
-- =====================================================================

do $$
begin
  if to_regnamespace('cron') is not null and exists (select 1 from cron.job where jobname = 'fx-sync-bdt') then
    perform cron.unschedule('fx-sync-bdt');
  end if;
end $$;

drop function if exists sync_fx_rates();
