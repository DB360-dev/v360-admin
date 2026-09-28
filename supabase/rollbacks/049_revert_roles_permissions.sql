-- =====================================================================
-- ROLLBACK for migrations/049_roles_permissions.sql
--
-- Kept OUTSIDE supabase/migrations on purpose so `supabase db push`
-- never runs it. Run it by hand in the Supabase SQL editor only if 049
-- has to be undone, then also revert the portal and manage-user code.
--
-- Puts back exactly what 049 replaced (saved in rbac_backup when 049
-- ran): every function, every policy, the status-transition rules and
-- each member's old role. Then removes roles, permissions and backups.
--
-- Members added AFTER 049 had no old role, so they are mapped:
--   * V360 user whose role can't see invoices -> 'warehouse' (restricted,
--     if the 047 enum value exists), otherwise 'operator'
--   * KBB user -> 'partner_agent'
-- =====================================================================

do $$
begin
  if to_regclass('public.rbac_backup') is null then
    raise exception 'rbac_backup not found: 049_roles_permissions was never applied or was already rolled back';
  end if;
end $$;

-- ---------- 1. Members' roles ----------------------------------------

do $$
declare
  v_has_warehouse boolean := exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'member_role' and e.enumlabel = 'warehouse');
  r record;
begin
  -- Membership trigger would null role_id / check types; not needed now.
  drop trigger if exists memberships_role_check on memberships;

  -- Members that existed before 049
  update memberships m set role = b.old_role::member_role
  from rbac_backup_memberships b where b.membership_id = m.id;

  -- Members added after 049 (non-admin V360 users)
  for r in
    select m.id, p.email, ro.name as role_name,
           exists (select 1 from role_permissions rp where rp.role_id = m.role_id and rp.permission = 'invoices.view') as sees_money
    from memberships m
    join organizations o on o.id = m.organization_id
    left join roles ro on ro.id = m.role_id
    left join profiles p on p.id = m.user_id
    where o.type = 'v360' and m.role::text <> 'admin'
      and not exists (select 1 from rbac_backup_memberships b where b.membership_id = m.id)
  loop
    if not r.sees_money and v_has_warehouse then
      update memberships set role = 'warehouse' where id = r.id;
      raise notice '% (role "%") -> warehouse', r.email, r.role_name;
    else
      update memberships set role = 'operator' where id = r.id;
      raise notice '% (role "%") -> operator', r.email, r.role_name;
    end if;
  end loop;

  update memberships m set role = 'partner_agent'
  from organizations o
  where o.id = m.organization_id and o.type = 'partner'
    and not exists (select 1 from rbac_backup_memberships b where b.membership_id = m.id);
end $$;

-- ---------- 2. Functions (original definitions, in saved order) -------

do $$
declare r record;
begin
  for r in select definition from rbac_backup where kind = 'function' order by seq loop
    execute r.definition;
  end loop;
end $$;

-- ---------- 3. Policies ------------------------------------------------

drop policy if exists brand_money_settings_staff_read on brand_money_settings;

do $$
declare r record;
begin
  for r in select * from rbac_backup where kind = 'policy' order by seq loop
    execute format('alter policy %I on %I', r.extra, r.name)
      || case when r.definition is not null then format(' using (%s)', r.definition) else '' end
      || case when r.definition2 is not null then format(' with check (%s)', r.definition2) else '' end;
  end loop;
end $$;

-- ---------- 4. Status transitions --------------------------------------

do $$
declare r record;
begin
  for r in select definition from rbac_backup where kind = 'constraint' loop
    alter table status_transitions drop constraint if exists status_transitions_actor_check;
    execute 'alter table status_transitions add constraint status_transitions_actor_check ' || r.definition;
  end loop;
  insert into status_transitions (from_status, to_status, actor)
  select name::order_status, extra::order_status, definition from rbac_backup where kind = 'transition'
  on conflict do nothing;
end $$;

-- ---------- 5. Safety check, then remove roles & permissions -----------

do $$
declare v_left text;
begin
  select string_agg(p.proname, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname not in ('v360_can', 'partner_can', 'transition_perm', 'save_role', 'delete_role', '_membership_role_check')
    and (p.prosrc like '%v360_can(%' or p.prosrc like '%partner_can(%' or p.prosrc like '%transition_perm(%');
  if v_left is not null then
    raise exception 'These functions still use permissions (changed after 049?): %. Fix them by hand first.', v_left;
  end if;

  select string_agg(tablename || '.' || policyname, ', ') into v_left
  from pg_policies
  where schemaname = 'public'
    and tablename not in ('roles', 'role_permissions', 'permissions')
    and (qual like '%v360_can(%' or qual like '%partner_can(%'
         or with_check like '%v360_can(%' or with_check like '%partner_can(%');
  if v_left is not null then
    raise exception 'These policies still use permissions: %. Fix them by hand first.', v_left;
  end if;
end $$;

drop function if exists save_role(uuid, org_type, text, text, text[]);
drop function if exists delete_role(uuid);
drop function if exists _membership_role_check();
alter table memberships drop column if exists role_id;
drop table if exists role_permissions;
drop table if exists roles;
drop table if exists permissions;
drop function if exists v360_can(text);
drop function if exists partner_can(text);
drop function if exists transition_perm(order_status);

drop table rbac_backup_memberships;
drop table rbac_backup;

-- ---------- 6. Warn if warehouse users now have full access ------------

do $$
begin
  if exists (select 1 from memberships where role::text = 'warehouse')
     and not exists (select 1 from pg_proc where proname = 'is_v360_warehouse') then
    raise warning 'Warehouse members exist but 048 (is_v360_warehouse) is not active, so they have FULL V360 access. Apply 048 or change their role.';
  end if;
end $$;
