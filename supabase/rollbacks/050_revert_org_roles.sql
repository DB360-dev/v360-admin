-- =====================================================================
-- ROLLBACK for migrations/050_org_roles.sql  (back to the 049 state)
--
-- Run by hand in the Supabase SQL editor only if 050 has to be undone,
-- then revert the ops portal, brand portal and edge functions in git.
-- Kept outside supabase/migrations so `supabase db push` never runs it.
--
-- What it does:
--   * Restores every function and policy 050 changed (from rbac050_backup)
--   * Removes brand_can / can_manage_org / save_org_role / brand presets
--   * Deletes roles 050 created (brand roles, KBB starter roles, copies)
--   * KBB admins become KBB agents with the "KBB agent" role
--   * Brand staff go back to plain brand_staff (full brand access, as before)
--   * Restores the permission catalog and the old role name uniqueness
-- All-or-nothing: one transaction.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.rbac050_backup') is null then
    raise exception 'rbac050_backup not found: 050_org_roles was never applied or was already rolled back';
  end if;
end $$;

-- ---------- 1. Members ------------------------------------------------------

drop trigger if exists organizations_brand_presets on organizations;
drop trigger if exists memberships_role_check on memberships;

-- Members 050 moved (KBB copies, brand staff) get their old role back.
update memberships m set role = b.old_role::member_role, role_id = b.old_role_id
from rbac050_backup_memberships b where b.membership_id = m.id;

-- KBB admins (new in 050) -> KBB agent with the "KBB agent" role of their org.
update memberships m set role = 'partner_agent',
  role_id = (select r.id from roles r where r.organization_id = m.organization_id and r.name = 'KBB agent' limit 1)
from organizations o
where o.id = m.organization_id and o.type = 'partner' and m.role = 'admin';

-- Brand staff added after 050 had brand roles: plain brand_staff again.
update memberships m set role_id = null
from organizations o where o.id = m.organization_id and o.type = 'brand';

-- KBB members on a KBB role 050 created (e.g. "Delivery team") -> "KBB agent".
update memberships m set role_id = (select r.id from roles r where r.organization_id = m.organization_id and r.name = 'KBB agent' limit 1)
where m.role_id in (select name::uuid from rbac050_backup where kind = 'role_created');

-- ---------- 2. Functions & policies --------------------------------------------

do $$
declare r record;
begin
  -- Original definitions, in the order they were saved
  for r in select definition from rbac050_backup where kind = 'function' order by seq loop
    execute r.definition;
  end loop;

  for r in select * from rbac050_backup where kind = 'policy' order by seq loop
    execute format('alter policy %I on %I', r.extra, r.name)
      || case when r.definition is not null then format(' using (%s)', r.definition) else '' end
      || case when r.definition2 is not null then format(' with check (%s)', r.definition2) else '' end;
  end loop;
end $$;

-- save_role / delete_role / partner_can / _membership_role_check were
-- restored above; put the 049 trigger back.
create trigger memberships_role_check before insert or update of role_id, role, organization_id on memberships
  for each row execute function _membership_role_check();

-- ---------- 3. Safety check ----------------------------------------------------

do $$
declare v_left text;
begin
  select string_agg(p.proname, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname not in ('brand_can', 'can_manage_org', 'brand_transition_perm', 'save_org_role',
                          '_create_brand_presets', '_organizations_brand_presets')
    and (p.prosrc like '%brand_can(%' or p.prosrc like '%can_manage_org(%' or p.prosrc like '%save_org_role(%'
         or p.prosrc like '%brand_transition_perm(%');
  if v_left is not null then
    raise exception 'These functions still use 050 helpers (changed after 050?): %. Fix them by hand first.', v_left;
  end if;

  select string_agg(tablename || '.' || policyname, ', ') into v_left
  from pg_policies where schemaname = 'public'
    and (qual like '%brand_can(%' or qual like '%can_manage_org(%'
         or with_check like '%brand_can(%' or with_check like '%can_manage_org(%');
  if v_left is not null then
    raise exception 'These policies still use 050 helpers: %. Fix them by hand first.', v_left;
  end if;
end $$;

-- ---------- 4. Remove 050 objects & data -----------------------------------------

drop function if exists save_org_role(uuid, uuid, text, text, text[]);
drop function if exists _organizations_brand_presets();
drop function if exists _create_brand_presets(uuid);
drop function if exists brand_can(uuid, text);
drop function if exists can_manage_org(uuid);
drop function if exists brand_transition_perm(order_status);

delete from roles where id in (select name::uuid from rbac050_backup where kind = 'role_created');
delete from roles where org_type = 'brand';

-- If a KBB admin created same-named roles in two KBB organizations, the old
-- (org_type, name) uniqueness can't come back: rename one and rerun.
drop index if exists roles_org_name_key;
alter table roles drop constraint if exists roles_org_type_check;
do $$
declare r record;
begin
  for r in select * from rbac050_backup where kind = 'constraint' loop
    execute format('alter table roles add constraint %I %s', r.name, r.definition);
  end loop;
  for r in select * from rbac050_backup where kind = 'index' loop
    execute r.definition;
  end loop;
end $$;
alter table roles drop column organization_id;

-- Permission catalog as it was
delete from role_permissions where permission not in (select name from rbac050_backup where kind = 'permission');
delete from permissions where key not in (select name from rbac050_backup where kind = 'permission');
update permissions p set applies_to = array(select json_array_elements_text(b.definition::json->'applies_to')),
                         description = b.definition::json->>'description'
from rbac050_backup b where b.kind = 'permission' and b.name = p.key;

drop table rbac050_backup_memberships;
drop table rbac050_backup;

commit;
