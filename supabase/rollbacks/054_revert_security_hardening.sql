-- =====================================================================
-- ROLLBACK for migrations/054_security_hardening.sql
--
-- Run by hand in the Supabase SQL editor only if 054 has to be undone.
-- Kept outside supabase/migrations so `supabase db push` never runs it.
-- WARNING: this puts the security holes 054 closed back in place.
--
-- What it does (from sec054_backup):
--   * Restores every function 054 changed (oldest definition wins)
--   * Restores / recreates the policies 054 changed or dropped
--   * Re-grants the table privileges 054 revoked (anon + authenticated)
--   * Re-grants EXECUTE to PUBLIC / anon / authenticated where 054 revoked it
--   * Puts the default privileges for new objects back
-- All-or-nothing: one transaction.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.sec054_backup') is null then
    raise exception 'sec054_backup not found: 054_security_hardening was never applied or was already rolled back';
  end if;
end $$;

-- ---------- 1. Functions (newest backup first, so the original ends up live) --
do $$
declare r record;
begin
  for r in select definition from sec054_backup where kind = 'function' order by seq desc loop
    execute r.definition;
  end loop;
end $$;

-- ---------- 2. Policies ------------------------------------------------------
do $$
declare r record; v_meta jsonb; v_expr jsonb; v_roles text;
begin
  for r in select * from sec054_backup where kind = 'policy' order by seq desc loop
    v_meta := r.definition::jsonb;
    v_expr := r.definition2::jsonb;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.name and policyname = r.extra) then
      execute format('alter policy %I on %I', r.extra, r.name)
        || case when v_expr->>'qual' is not null then format(' using (%s)', v_expr->>'qual') else '' end
        || case when v_expr->>'with_check' is not null then format(' with check (%s)', v_expr->>'with_check') else '' end;
    else
      select string_agg(case when x = 'public' then 'public' else quote_ident(x) end, ', ') into v_roles
      from jsonb_array_elements_text(v_meta->'roles') x;
      execute format('create policy %I on %I as %s for %s to %s', r.extra, r.name,
                     v_meta->>'permissive', v_meta->>'cmd', coalesce(v_roles, 'public'))
        || case when v_expr->>'qual' is not null then format(' using (%s)', v_expr->>'qual') else '' end
        || case when v_expr->>'with_check' is not null then format(' with check (%s)', v_expr->>'with_check') else '' end;
    end if;
  end loop;
end $$;

-- ---------- 3. Table privileges ------------------------------------------------
revoke update (role, role_id) on memberships from authenticated;

do $$
declare r record;
begin
  for r in select distinct name, extra, definition, definition2 from sec054_backup where kind = 'table_grant' loop
    if to_regclass('public.' || quote_ident(r.name)) is null then continue; end if;
    if r.definition2 = 'S' then
      execute format('grant %s on sequence %I to %I', r.definition, r.name, r.extra);
    else
      execute format('grant %s on table %I to %I', r.definition, r.name, r.extra);
    end if;
  end loop;
end $$;

-- ---------- 4. Function EXECUTE ----------------------------------------------
do $$
declare r record;
begin
  for r in select * from sec054_backup where kind in ('function_acl', 'function_revoke') loop
    if to_regprocedure(r.name) is null then continue; end if;
    if r.kind = 'function_revoke' then
      execute format('grant execute on function %s to authenticated', to_regprocedure(r.name));
    else
      if r.extra = 'public' then execute format('grant execute on function %s to public', to_regprocedure(r.name)); end if;
      if r.definition = 'anon' then execute format('grant execute on function %s to anon', to_regprocedure(r.name)); end if;
    end if;
  end loop;
end $$;

-- ---------- 5. Default privileges for new objects ------------------------------
do $$
declare v_tables text; v_seqs text; v_funcs text; v_has_funcs boolean;
begin
  select definition into v_tables from sec054_backup where kind = 'default_acl' and name = 'r';
  select definition into v_seqs   from sec054_backup where kind = 'default_acl' and name = 'S';
  select definition into v_funcs  from sec054_backup where kind = 'default_acl' and name = 'f';
  v_has_funcs := exists (select 1 from sec054_backup where kind = 'default_acl' and name = 'f');

  if position('anon=' in coalesce(v_tables, '')) > 0 then
    alter default privileges for role postgres in schema public grant all on tables to anon;
  end if;
  if position('anon=' in coalesce(v_seqs, '')) > 0 then
    alter default privileges for role postgres in schema public grant all on sequences to anon;
  end if;
  if position('anon=' in coalesce(v_funcs, '')) > 0 then
    alter default privileges for role postgres in schema public grant execute on functions to anon;
  end if;
  -- No entry, or an entry granting PUBLIC (empty grantee), means PUBLIC had EXECUTE.
  if not v_has_funcs or v_funcs ~ '(^\{|,)=X' then
    alter default privileges for role postgres in schema public grant execute on functions to public;
  end if;
end $$;

drop table sec054_backup;

commit;
