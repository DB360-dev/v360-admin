-- =====================================================================
-- 056_fx_auto_sync.sql — BDT exchange rates from open.er-api.com
--
-- sync_fx_rates() fetches https://open.er-api.com/v6/latest/BDT and saves
-- the day's rate in fx_rates (the table every conversion already uses):
--   BDT -> PKR  (fx_rate_pkr / fx_convert, invoices, ledger, payouts)
--   PKR -> BDT  (the inverse, shown in the brand portal)
-- rate_date = the API's last update date (UTC). Orders keep using the rate of
-- their own order date, so past amounts don't move.
--
-- A rate entered by hand on the FX rates page always wins: auto rows are
-- marked with a note starting "Auto:" and only those are overwritten.
--
-- Runs: pg_cron at 00:15, 06:15, 12:15 and 18:15 UTC (if pg_cron is
-- available; otherwise enable it in the Supabase dashboard and re-run the
-- schedule block), and from the "Fetch today's rate" button (fx.manage).
-- Rollback: supabase/rollbacks/056_revert_fx_auto_sync.sql
-- =====================================================================

begin;

create extension if not exists http with schema extensions;

create or replace function sync_fx_rates() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  r         extensions.http_response;
  j         jsonb;
  v_rate    numeric;
  v_date    date;
  v_note    text := 'Auto: open.er-api.com';
  v_saved   text[] := '{}';
  v_kept    text[] := '{}';
  p         record;
begin
  -- Signed-in callers need "Add and edit FX rates"; pg_cron runs without a user.
  if auth.uid() is not null and not v360_can('fx.manage') then
    raise exception 'Your role can''t update FX rates';
  end if;

  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '15');
  r := extensions.http_get('https://open.er-api.com/v6/latest/BDT');
  if r.status <> 200 then
    raise exception 'The FX service returned HTTP %', r.status;
  end if;
  j := r.content::jsonb;
  if j->>'result' is distinct from 'success' then
    raise exception 'The FX service returned an error: %', coalesce(j->>'error-type', 'unknown');
  end if;

  v_rate := (j#>>'{rates,PKR}')::numeric;
  -- Sanity check (1 BDT has been ~2–3 PKR): never save a broken value.
  if v_rate is null or v_rate < 0.5 or v_rate > 10 then
    raise exception 'Unexpected BDT to PKR rate from the FX service: %', v_rate;
  end if;
  v_date := (to_timestamp((j->>'time_last_update_unix')::bigint) at time zone 'UTC')::date;

  for p in select * from (values ('BDT', 'PKR', round(v_rate, 6)), ('PKR', 'BDT', round(1 / v_rate, 6))) t(base, quote, rate) loop
    if exists (select 1 from fx_rates f
               where f.rate_date = v_date and f.base = p.base and f.quote = p.quote
                 and coalesce(f.note, '') not like 'Auto:%') then
      v_kept := v_kept || (p.base || '->' || p.quote);   -- entered by hand: keep it
      continue;
    end if;
    insert into fx_rates (rate_date, base, quote, rate, note)
    values (v_date, p.base, p.quote, p.rate, v_note)
    on conflict (rate_date, base, quote) do update set rate = excluded.rate, note = excluded.note;
    v_saved := v_saved || (p.base || '->' || p.quote);
  end loop;

  return jsonb_build_object('rate_date', v_date, 'bdt_to_pkr', round(v_rate, 6), 'pkr_to_bdt', round(1 / v_rate, 6),
                            'saved', to_jsonb(v_saved), 'kept_manual', to_jsonb(v_kept), 'source', 'open.er-api.com');
end $$;

revoke all on function sync_fx_rates() from public, anon;
grant execute on function sync_fx_rates() to authenticated, service_role;

commit;

-- ---------- Schedule (outside the transaction: optional) ------------------------
-- If pg_cron can't be enabled here, turn it on under Database > Extensions,
-- then run just this block again.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron is not available (%). Enable it in the dashboard, then re-run this block.', sqlerrm;
    return;
  end;
  if exists (select 1 from cron.job where jobname = 'fx-sync-bdt') then
    perform cron.unschedule('fx-sync-bdt');
  end if;
  perform cron.schedule('fx-sync-bdt', '15 0,6,12,18 * * *', 'select public.sync_fx_rates()');
  raise notice 'Scheduled fx-sync-bdt (00:15, 06:15, 12:15, 18:15 UTC)';
end $$;

-- Fetch today's rate now.
select public.sync_fx_rates();
