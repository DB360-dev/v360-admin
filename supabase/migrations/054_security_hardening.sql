-- =====================================================================
-- 054_security_hardening.sql — Close holes found in the 2026-09-28 audit
--
--   1. Brand action functions let ANY signed-in user (and, for
--      brand_import_order, anyone with the public anon key) act on any
--      brand: actor_group_for() is NULL for outsiders and
--      `NULL not in ('brand','v360')` is NULL, so the guard never raised.
--      Every such guard is rewritten to coalesce(..., '-').
--   2. Invoices: the FOR ALL policy let KBB insert / edit / delete invoices
--      directly, skipping the invoice functions. Writes now go through the
--      (security definer) functions only; reads keep invoices_read.
--   3. Memberships: brand owners / KBB admins could insert a membership for
--      ANY user id (or repoint one), then read that user's profile. Direct
--      inserts are gone (manage-user adds members); updates are limited to
--      role / role_id.
--   4. Commission settings: money_settings was readable by everyone signed
--      in, get_brand_money_settings by anyone at all. Both are now gated.
--   5. shopify_connections and bd_received_items: no direct writes from the
--      browser (edge functions / definer functions do them).
--   6. anon (the public key, not signed in) loses every table privilege and
--      EXECUTE on public functions; signed-in users lose TRUNCATE / TRIGGER /
--      REFERENCES. Future tables and functions don't get anon grants either.
--   7. Courier settings (if 053 is applied): API base URL must be RedX,
--      tracking link must be https:// (a javascript: link ran in V360
--      staff browsers).
--
-- Stops without changing anything if a non-definer function still writes
-- one of the locked tables (it would break). All-or-nothing, one
-- transaction. Everything changed is saved in sec054_backup for
-- supabase/rollbacks/054_revert_security_hardening.sql.
-- =====================================================================

begin;

create table sec054_backup (
  seq         serial primary key,
  kind        text not null,  -- function | policy | table_grant | function_acl | default_acl
  name        text not null,
  extra       text,
  definition  text,
  definition2 text
);
alter table sec054_backup enable row level security;
revoke all on sec054_backup from anon, authenticated;

-- ---------- 0. Pre-flight: nothing that writes a locked table may break ----
-- Signed-in users lose direct writes on these tables below. Any function
-- they can call (or any trigger) that writes them must be security definer.
do $$
declare v_bad text;
begin
  select string_agg(distinct p.oid::regprocedure::text || ' -> ' || t, ', ') into v_bad
  from pg_proc p
  cross join unnest(array['invoices', 'memberships', 'shopify_connections', 'bd_received_items', 'money_settings',
                          'roles', 'role_permissions']) t
  where p.pronamespace = 'public'::regnamespace
    and not p.prosecdef
    and (p.prorettype = 'trigger'::regtype or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    and p.prosrc ~* ('(insert\s+into|update|delete\s+from)\s+(public\.)?' || t || '\M');
  if v_bad is not null then
    raise exception 'Not applied: these functions write a locked table but are not security definer: %', v_bad;
  end if;
end $$;

-- ---------- Helpers (dropped at the end) ------------------------------------

create function _s54_policy(p_table text, p_policy text) returns void language plpgsql as $$
declare r record;
begin
  select * into r from pg_policies where schemaname = 'public' and tablename = p_table and policyname = p_policy;
  if not found then raise exception 'Policy % on % not found', p_policy, p_table; end if;
  insert into sec054_backup (kind, name, extra, definition, definition2)
  values ('policy', p_table, p_policy,
          jsonb_build_object('cmd', r.cmd, 'roles', r.roles, 'permissive', r.permissive)::text,
          jsonb_build_object('qual', r.qual, 'with_check', r.with_check)::text);
end $$;

-- Save the table privileges a role holds on a table (for the rollback).
create function _s54_table_grants(p_role text, p_table text default null) returns void language plpgsql as $$
begin
  insert into sec054_backup (kind, name, extra, definition, definition2)
  select 'table_grant', c.relname, p_role, a.privilege_type, c.relkind::text
  from pg_class c cross join aclexplode(c.relacl) a
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and a.grantee = p_role::regrole
    and (p_table is null or c.relname = p_table);
end $$;

-- Back up every overload of a function and apply text replacements to it.
-- p_optional: skip (with a notice) when the function or text isn't there.
create function _s54_patch(p_name text, p_from text, p_to text, p_optional boolean default false)
returns void language plpgsql as $$
declare r record; v_def text; v_n int := 0;
begin
  for r in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_name loop
    v_def := pg_get_functiondef(r.oid);
    if position(p_from in v_def) = 0 then continue; end if;
    insert into sec054_backup (kind, name, definition) values ('function', p_name, v_def);
    execute replace(v_def, p_from, p_to);
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    if p_optional then raise notice '%: expected text not found, skipped', p_name; return; end if;
    raise exception '%: expected text not found', p_name;
  end if;
end $$;

-- Insert code right after the first "begin" of every overload's body.
create function _s54_prepend(p_name text, p_code text) returns void language plpgsql as $$
declare r record; v_def text; v_new text; v_n int := 0;
begin
  for r in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_name loop
    v_def := pg_get_functiondef(r.oid);
    insert into sec054_backup (kind, name, definition) values ('function', p_name, v_def);
    -- 'i': some functions are written in upper case (BEGIN). No 'g': first match only.
    v_new := regexp_replace(v_def, '(\$function\$.*?\mbegin\M)', '\1' || chr(10) || replace(p_code, '\', '\\'), 'i');
    if v_new = v_def then raise exception '%: body "begin" not found', p_name; end if;
    execute v_new;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'Function % not found', p_name; end if;
end $$;

-- Change a policy if it exists (backed up first).
create function _s54_alter_policy(p_table text, p_policy text, p_using text, p_check text default null)
returns void language plpgsql as $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = p_table and policyname = p_policy) then
    raise notice 'Policy % on % not found, skipped', p_policy, p_table; return;
  end if;
  perform _s54_policy(p_table, p_policy);
  execute format('alter policy %I on %I', p_policy, p_table)
    || case when p_using is not null then format(' using (%s)', p_using) else '' end
    || case when p_check is not null then format(' with check (%s)', p_check) else '' end;
end $$;

-- ---------- 1. NULL guard hole --------------------------------------------
do $$
declare
  r      record;
  v_def  text;
  v_new  text;
  v_n    int := 0;
  v_left text;
begin
  for r in select p.oid, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.prosrc ~ '(actor_group_for\([a-z_.]+\)|v_actor) not in \(''brand'', ''v360''\)' loop
    v_def := pg_get_functiondef(r.oid);
    insert into sec054_backup (kind, name, definition) values ('function', r.proname, v_def);
    v_new := regexp_replace(v_def,
      '(actor_group_for\([a-z_.]+\)|v_actor) not in \(''brand'', ''v360''\)',
      'coalesce(\1, ''-'') not in (''brand'', ''v360'')', 'g');
    execute v_new;
    v_n := v_n + 1;
  end loop;
  raise notice 'NULL guard fixed in % function(s)', v_n;

  select string_agg(proname, ', ') into v_left from pg_proc
  where pronamespace = 'public'::regnamespace
    and prosrc ~ '(actor_group_for\([a-z_.]+\)|v_actor) not in \(''brand'', ''v360''\)';
  if v_left is not null then raise exception 'NULL guard still present in: %', v_left; end if;
end $$;

-- Dispatch: a SKU line could be marked "from local stock" when the brand had
-- no stock row at all (nothing deducted, hub receiving skipped). The portal
-- only offers stock the brand has, so this only stops forged calls.
select _s54_patch('create_inbound_batch', 'if found and v_left < 0 then', 'if not found or v_left < 0 then', true);

-- ---------- 2. Invoices: writes only through the invoice functions --------
select _s54_policy('invoices', 'Invoices are manageable by staff');
select _s54_table_grants('authenticated', 'invoices');
drop policy "Invoices are manageable by staff" on invoices;
revoke insert, update, delete on invoices from authenticated;

-- save_generated_invoice (KBB invoices): can't create brand payouts, and
-- can't overwrite an existing invoice of another type (e.g. a brand payout).
-- Re-saving the same KBB invoice still updates its totals as before.
select _s54_prepend('save_generated_invoice', $c$
  if p_invoice_type = 'brand_payout' then
    raise exception 'Brand payout invoices are created from Brand payouts';
  end if;
  if exists (select 1 from invoices where invoice_number = p_invoice_number and invoice_type <> p_invoice_type) then
    raise exception 'Invoice % already exists as a different kind of invoice', p_invoice_number;
  end if;$c$);

-- KBB can't change the payment status of brand payout invoices (V360's).
select _s54_prepend('set_invoice_payment_status', $c$
  if not v360_can('invoices.payment_status')
     and exists (select 1 from invoices where invoice_number = p_invoice_number and invoice_type = 'brand_payout') then
    raise exception 'Your role can''t change this invoice';
  end if;$c$);

-- ---------- 3. Memberships ----------------------------------------------------
-- New members come from the manage-user edge function (service role).
-- Portals only change role / role_id, or delete.
select _s54_table_grants('authenticated', 'memberships');
revoke insert, update on memberships from authenticated;
grant update (role, role_id) on memberships to authenticated;

-- ---------- 4. Commission settings ------------------------------------------
select _s54_policy('money_settings', 'money_settings_read');
alter policy money_settings_read on money_settings
  using (v360_can('money.view') or v360_can('money.settings'));

-- get_brand_money_settings: caller must be allowed to see money.
select _s54_prepend('get_brand_money_settings', $c$
  if not (v360_can('brands.settings') or v360_can('money.view') or v360_can('money.settings')
          or v360_can('orders.view_money') or partner_can('orders.view_money') or partner_can('money.view')) then
    raise exception 'Your role can''t see money settings';
  end if;$c$);

select _s54_table_grants('authenticated', 'money_settings');
revoke insert, update, delete on money_settings from authenticated;

-- ---------- 5. Shopify connections, BD receiving: no direct writes -----------
select _s54_table_grants('authenticated', 'shopify_connections');
revoke insert, update, delete on shopify_connections from authenticated;

select _s54_table_grants('authenticated', 'bd_received_items');
revoke insert, update, delete on bd_received_items from authenticated;

-- Roles are saved with save_org_role / delete_role only.
select _s54_table_grants('authenticated', 'roles');
select _s54_table_grants('authenticated', 'role_permissions');
revoke insert, update, delete on roles, role_permissions from authenticated;

-- Backup tables hold SQL the rollbacks run: nobody reads them via the API.
do $$
declare t text;
begin
  foreach t in array array['rbac_backup', 'rbac050_backup', 'rbac050_backup_memberships'] loop
    if to_regclass('public.' || t) is not null then
      perform _s54_table_grants('authenticated', t);
      execute format('revoke all on %I from authenticated', t);
    end if;
  end loop;
end $$;

-- ---------- 5b. Cross-brand reads -------------------------------------------
-- A brand saw every brand's weight rows in a shipment it shared (brand ids,
-- weights). Now only its own rows; V360 / KBB unchanged.
select _s54_alter_policy('shipment_brand_weights', 'weight_read',
  'is_v360() or is_partner() or is_brand_member(brand_id)');

-- Brands only get the brand permissions (the catalogue named V360/KBB steps).
select _s54_alter_policy('permissions', 'permissions_read',
  'is_v360() or is_partner() or ''brand'' = any(applies_to)');

-- Editing a dispatch: the portal already requires "dispatch.create".
select _s54_alter_policy('inbound_batches', 'inbound_update',
  'v360_can(''hub.receive'') or (brand_can(brand_id, ''dispatch.create'') and status = ''in_transit'')',
  'v360_can(''hub.receive'') or brand_can(brand_id, ''dispatch.create'')');

-- ---------- 6. anon and dangerous privileges ------------------------------
-- Tables: anon loses everything (portals only call auth.* before sign-in).
select _s54_table_grants('anon');
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Signed-in users never need these (TRUNCATE also skips RLS).
insert into sec054_backup (kind, name, extra, definition, definition2)
select 'table_grant', c.relname, 'authenticated', a.privilege_type, c.relkind::text
from pg_class c cross join aclexplode(c.relacl) a
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and a.grantee = 'authenticated'::regrole and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES');
revoke truncate, trigger, references on all tables in schema public from authenticated;

-- Functions: anon loses EXECUTE. Functions open to PUBLIC keep it for every
-- other role that had it (authenticated, service_role, auth hooks...).
do $$
declare
  r         record;
  v_acl     aclitem[];
  v_public  boolean;
  v_anon    boolean;
  v_roles   text[];
  v_role    text;
  v_n       int := 0;
begin
  for r in select p.oid, p.oid::regprocedure::text as sig, p.proowner, p.proacl from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.prokind in ('f', 'p')
             and p.proname not like '\_s54\_%'
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
             and has_function_privilege('anon', p.oid, 'EXECUTE') loop
    v_acl := coalesce(r.proacl, acldefault('f', r.proowner));
    v_public := exists (select 1 from aclexplode(v_acl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE');
    v_anon := exists (select 1 from aclexplode(v_acl) a where a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE');

    v_roles := '{}';
    if v_public then
      select coalesce(array_agg(rolname), '{}') into v_roles from pg_roles
      where rolname <> 'anon' and rolname !~ '^pg_'
        and has_function_privilege(oid, r.oid, 'EXECUTE')
        and oid <> r.proowner;
    end if;

    insert into sec054_backup (kind, name, extra, definition)
    values ('function_acl', r.sig, case when v_public then 'public' end, case when v_anon then 'anon' end);

    execute format('revoke execute on function %s from public, anon', r.sig);
    foreach v_role in array v_roles loop
      execute format('grant execute on function %s to %I', r.sig, v_role);
    end loop;
    v_n := v_n + 1;
  end loop;
  raise notice 'anon EXECUTE removed from % function(s)', v_n;
end $$;

-- Future objects created by postgres: nothing for anon; functions go to
-- signed-in users and the service role explicitly instead of PUBLIC.
insert into sec054_backup (kind, name, definition)
select 'default_acl', defaclobjtype::text, defaclacl::text from pg_default_acl
where defaclrole = 'postgres'::regrole and defaclnamespace = 'public'::regnamespace;

alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public grant execute on functions to authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;

-- ---------- 7. Courier settings (only if 053 is applied) --------------------
do $$
declare r record; v_def text; v_new text;
begin
  select p.oid into r from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'save_courier_account';
  if not found then raise notice 'save_courier_account not found, skipped'; return; end if;
  v_def := pg_get_functiondef(r.oid);
  if position('The API base URL must start with https://' in v_def) = 0 then
    raise notice 'save_courier_account already has the new checks, skipped'; return;
  end if;
  insert into sec054_backup (kind, name, definition) values ('function', 'save_courier_account', v_def);
  v_new := replace(v_def,
    $old$if coalesce(trim(p_base_url), '') !~* '^https://' then raise exception 'The API base URL must start with https://'; end if;$old$,
    $new$if coalesce(trim(p_base_url), '') !~* '^https://(openapi|sandbox)\.redx\.com\.bd(/|$)' then
    raise exception 'The API base URL must be openapi.redx.com.bd or sandbox.redx.com.bd';
  end if;
  if coalesce(trim(p_tracking_url_template), '') !~* '^https://' then
    raise exception 'The tracking link must start with https://';
  end if;$new$);
  if v_new = v_def then raise exception 'save_courier_account: expected text not found'; end if;
  execute v_new;

  if exists (select 1 from courier_accounts
             where base_url !~* '^https://(openapi|sandbox)\.redx\.com\.bd(/|$)'
                or tracking_url_template !~* '^https://') then
    raise warning 'A saved courier account has a non-RedX API URL or a non-https tracking link. Fix it in Courier settings.';
  end if;
end $$;

-- ---------- 8. Internal-only functions: not callable from the browser ------
-- Freight helpers had no caller check (any order's freight cost). They are
-- only used inside definer functions. Skipped if a view or an invoker
-- function uses them (revoking would break it).
do $$
declare r record; v_users text;
begin
  for r in select p.oid, p.oid::regprocedure::text as sig, p.proname from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('order_freight_share_pkr', 'order_freight_pkr') loop
    select string_agg(distinct v.relname, ', ') into v_users
    from pg_depend d join pg_rewrite w on w.oid = d.objid join pg_class v on v.oid = w.ev_class
    where d.classid = 'pg_rewrite'::regclass and d.refobjid = r.oid;
    if v_users is null then
      select string_agg(p2.proname, ', ') into v_users from pg_proc p2
      where p2.pronamespace = 'public'::regnamespace and not p2.prosecdef and p2.oid <> r.oid
        and p2.prosrc like '%' || r.proname || '(%';
    end if;
    if v_users is not null then
      raise notice '% still used by % (not definer), left callable', r.sig, v_users;
      continue;
    end if;
    insert into sec054_backup (kind, name, extra) values ('function_revoke', r.sig, 'authenticated');
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- Old overloads the portals no longer call; they skip newer checks
-- (auto-return of short orders, return-decision rules, weight step).
do $$
declare v_sig text;
begin
  foreach v_sig in array array['bd_confirm_shipment_receiving(uuid)',
                               'set_return_disposition(uuid, return_disposition, text)',
                               'receive_order(uuid, jsonb, text)'] loop
    if to_regprocedure(v_sig) is not null then
      insert into sec054_backup (kind, name, extra) values ('function_revoke', to_regprocedure(v_sig)::text, 'authenticated');
      execute format('revoke execute on function %s from public, anon, authenticated', to_regprocedure(v_sig));
    end if;
  end loop;
end $$;

drop function _s54_policy(text, text);
drop function _s54_table_grants(text, text);
drop function _s54_patch(text, text, text, boolean);
drop function _s54_prepend(text, text);
drop function _s54_alter_policy(text, text, text, text);

commit;
