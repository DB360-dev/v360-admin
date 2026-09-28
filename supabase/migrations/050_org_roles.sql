-- =====================================================================
-- 050_org_roles.sql — Every company manages its own staff and roles
--
-- Builds on 049 (roles + permissions):
--   * Roles now belong to ONE organization (V360, KBB, or a brand).
--   * Built-in admins per company:
--       V360  -> member role 'admin'        (unchanged)
--       KBB   -> member role 'admin'        (new: "KBB admin")
--       Brand -> member role 'brand_owner'  (unchanged)
--     They have every permission for their company, add staff and build
--     roles. V360 admins can manage every company (support / oversight).
--   * Brand permissions (confirm, prepare, dispatch, invoices, stock...)
--     are enforced by brand_can(brand_id, perm) in the brand-side
--     functions and policies. Existing brand staff get the "Staff" preset
--     (same access as today); owners keep full access.
--   * Starter roles: brands get Staff / Customer service / Warehouse
--     manager, KBB gets Confirmation team / Delivery team.
--
-- Also closes gaps left by 049 on the live database (functions and
-- policies from the brand project that still trusted any V360 member):
-- order_money_overview, order_kbb_money, settlements (brand read was lost),
-- send_order_message, inventory, Shopify disconnect.
--
-- All-or-nothing: wrapped in one transaction. Every changed function and
-- policy is backed up in rbac050_backup for
-- supabase/rollbacks/050_revert_org_roles.sql.
-- =====================================================================

begin;

-- ---------- Backups ------------------------------------------------------

create table rbac050_backup (
  seq         serial primary key,
  kind        text not null,     -- function | policy | permission | role_created | index | constraint
  name        text not null,
  extra       text,
  definition  text,
  definition2 text
);
create table rbac050_backup_memberships (
  membership_id uuid primary key,
  old_role      text not null,
  old_role_id   uuid
);
alter table rbac050_backup enable row level security;
alter table rbac050_backup_memberships enable row level security;

-- ---------- Patch helpers (dropped at the end) --------------------------

create function _r50_backup_fn(p_name text) returns int language plpgsql as $$
declare r record; v_n int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = p_name loop
    insert into rbac050_backup (kind, name, definition) values ('function', p_name, pg_get_functiondef(r.oid));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Replace exact text in every overload of a function. A pair's 3rd
-- element 'optional' allows it to be missing; otherwise missing = error.
-- p_optional_fn: skip (with a notice) when the function doesn't exist at all
-- (some brand-project functions were never applied to the live database).
create function _r50_patch(p_name text, p_pairs jsonb, p_optional_fn boolean default false) returns void language plpgsql as $$
declare r record; v_def text; v_new text; v_pair jsonb; v_n int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = p_name loop
    v_n := v_n + 1;
    v_def := pg_get_functiondef(r.oid);
    insert into rbac050_backup (kind, name, definition) values ('function', p_name, v_def);
    v_new := v_def;
    for v_pair in select value from jsonb_array_elements(p_pairs) loop
      if position(v_pair->>0 in v_new) = 0 and coalesce(v_pair->>2, '') <> 'optional' then
        raise exception '%: expected text not found: %', p_name, v_pair->>0;
      end if;
      v_new := replace(v_new, v_pair->>0, v_pair->>1);
    end loop;
    if v_new = v_def then raise exception '%: nothing to change', p_name; end if;
    execute v_new;
  end loop;
  if v_n = 0 then
    if p_optional_fn then raise notice 'Function % not found, skipped', p_name; return; end if;
    raise exception 'Function % not found', p_name;
  end if;
end $$;

-- Back up a policy and set new expressions (null = leave that part alone).
create function _r50_policy(p_table text, p_policy text, p_using text, p_check text default null, p_optional boolean default false)
returns void language plpgsql as $$
declare v_qual text; v_check text;
begin
  select qual, with_check into v_qual, v_check from pg_policies
  where schemaname = 'public' and tablename = p_table and policyname = p_policy;
  if not found then
    if p_optional then raise notice 'Policy % on % not found, skipped', p_policy, p_table; return; end if;
    raise exception 'Policy % on % not found', p_policy, p_table;
  end if;
  insert into rbac050_backup (kind, name, extra, definition, definition2) values ('policy', p_table, p_policy, v_qual, v_check);
  execute format('alter policy %I on %I', p_policy, p_table)
    || case when p_using is not null then format(' using (%s)', p_using) else '' end
    || case when p_check is not null then format(' with check (%s)', p_check) else '' end;
end $$;

-- ---------- 1. Permission catalog ----------------------------------------

insert into rbac050_backup (kind, name, definition)
select 'permission', key, row_to_json(p)::text from permissions p;

-- Shared keys that brands can use too
update permissions set applies_to = applies_to || '{brand}'
where key in ('orders.view', 'orders.view_money', 'orders.cancel', 'orders.edit_customer', 'orders.messages',
              'orders.internal_notes', 'invoices.view', 'inventory.view', 'money.view', 'activity.view')
  and not 'brand' = any(applies_to);

-- Brand staff read these labels: keep them free of company names.
update permissions set description = 'Send and read messages on an order.' where key = 'orders.messages';
update permissions set description = 'Payments, statements and account balances.' where key = 'money.view';

insert into permissions (key, area, label, description, applies_to, sort) values
  ('orders.confirm',   'Orders',   'Confirm orders',              'Confirm new orders before they are prepared.',        '{brand}', 110),
  ('orders.prepare',   'Orders',   'Mark orders as preparing',    null,                                                  '{brand}', 111),
  ('orders.import',    'Orders',   'Import orders',               'Add orders from a spreadsheet.',                      '{brand}', 112),
  ('dispatch.view',    'Dispatch', 'View ready-to-send and dispatches', null,                                            '{brand}', 1400),
  ('dispatch.create',  'Dispatch', 'Dispatch orders to the hub',  'Send parcels to the hub with courier and tracking.',  '{brand}', 1401),
  ('inventory.manage', 'Inventory','Manage local stock',          'Add, change and remove local stock.',                 '{brand}', 601),
  ('shopify.manage',   'Settings', 'Connect and sync Shopify',    null,                                                  '{brand}', 1500);

-- ---------- 2. Roles belong to an organization ---------------------------

alter table roles add column organization_id uuid references organizations(id) on delete cascade;

insert into rbac050_backup (kind, name, definition)
select 'constraint', conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'roles'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%org_type%';
insert into rbac050_backup (kind, name, definition)
select 'index', indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = 'roles_org_type_name_key';

do $$
declare
  v_v360    uuid := (select id from organizations where type = 'v360' order by created_at limit 1);
  v_first   uuid;
  r_org     record;
  r_role    record;
  v_new     uuid;
begin
  update roles set organization_id = v_v360 where org_type = 'v360';

  -- KBB roles: first KBB organization keeps them; any other KBB org gets copies.
  for r_org in select id from organizations where type = 'partner' order by created_at loop
    if v_first is null then
      v_first := r_org.id;
      update roles set organization_id = r_org.id where org_type = 'partner';
      continue;
    end if;
    for r_role in select * from roles where org_type = 'partner' and organization_id = v_first loop
      insert into roles (org_type, organization_id, name, description, is_preset)
      values ('partner', r_org.id, r_role.name, r_role.description, r_role.is_preset) returning id into v_new;
      insert into rbac050_backup (kind, name) values ('role_created', v_new::text);
      insert into role_permissions (role_id, permission) select v_new, permission from role_permissions where role_id = r_role.id;
      insert into rbac050_backup_memberships (membership_id, old_role, old_role_id)
      select id, role::text, role_id from memberships where organization_id = r_org.id and role_id = r_role.id
      on conflict do nothing;
      update memberships set role_id = v_new where organization_id = r_org.id and role_id = r_role.id;
    end loop;
  end loop;

  delete from roles where organization_id is null;   -- only possible with no V360/KBB org at all
end $$;

alter table roles alter column organization_id set not null;
alter table roles drop constraint if exists roles_org_type_check;
alter table roles add constraint roles_org_type_check check (org_type in ('v360', 'partner', 'brand'));
drop index if exists roles_org_type_name_key;
create unique index roles_org_name_key on roles (organization_id, lower(name));
create index on roles (organization_id);

-- ---------- 3. Permission checks -----------------------------------------

select _r50_backup_fn('partner_can');
-- KBB admins have every KBB permission.
create or replace function partner_can(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'partner' and o.is_active
      and (m.role = 'admin'
           or exists (select 1 from role_permissions rp where rp.role_id = m.role_id and rp.permission = p_perm))
  )
$$;

-- Brand owners have every brand permission; staff get their role's.
create function brand_can(p_brand_id uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and m.organization_id = p_brand_id and o.type = 'brand' and o.is_active
      and (m.role = 'brand_owner'
           or exists (select 1 from role_permissions rp where rp.role_id = m.role_id and rp.permission = p_perm))
  )
$$;

-- Who may add staff and build roles for an organization.
create function can_manage_org(p_org_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_v360_admin() or exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and m.organization_id = p_org_id and o.is_active
      and ((o.type = 'partner' and m.role = 'admin') or (o.type = 'brand' and m.role = 'brand_owner'))
  )
$$;

-- Permission a brand needs for a change_order_status move.
create function brand_transition_perm(p_to order_status) returns text
language sql immutable as $$
  select case
    when p_to = 'cancelled' then 'orders.cancel'
    when p_to in ('new', 'brand_confirmed') then 'orders.confirm'
    else 'orders.prepare' end
$$;

revoke all on function brand_can(uuid, text), can_manage_org(uuid), brand_transition_perm(order_status) from public, anon;
grant execute on function brand_can(uuid, text), can_manage_org(uuid), brand_transition_perm(order_status) to authenticated;

-- ---------- 4. Membership rules --------------------------------------------

select _r50_backup_fn('_membership_role_check');
create or replace function _membership_role_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org_type org_type;
  v_role_org uuid;
begin
  select type into v_org_type from organizations where id = new.organization_id;

  if not (   (v_org_type = 'v360'    and new.role::text in ('admin', 'operator'))
          or (v_org_type = 'partner' and new.role::text in ('admin', 'partner_agent'))
          or (v_org_type = 'brand'   and new.role::text in ('brand_owner', 'brand_staff'))) then
    raise exception 'Role "%" isn''t valid for this organization', new.role;
  end if;

  -- Built-in admins have full access and no custom role.
  if new.role::text in ('admin', 'brand_owner') then
    new.role_id := null;
    return new;
  end if;

  if new.role_id is not null then
    select organization_id into v_role_org from roles where id = new.role_id;
    if v_role_org is distinct from new.organization_id then
      raise exception 'That role belongs to a different organization';
    end if;
  end if;
  return new;
end $$;

-- ---------- 5. Starter roles ------------------------------------------------

create function _create_brand_presets(p_brand_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_staff uuid; v_id uuid;
begin
  insert into roles (org_type, organization_id, name, description, is_preset)
  values ('brand', p_brand_id, 'Staff', 'Everything except connecting Shopify.', true) returning id into v_staff;
  insert into role_permissions (role_id, permission)
  select v_staff, key from permissions where 'brand' = any(applies_to) and key <> 'shopify.manage';

  insert into roles (org_type, organization_id, name, description, is_preset)
  values ('brand', p_brand_id, 'Customer service', 'Confirms orders and answers messages. No invoices or payments.', true) returning id into v_id;
  insert into role_permissions (role_id, permission)
  select v_id, unnest(array['orders.view', 'orders.confirm', 'orders.edit_customer', 'orders.messages']);

  insert into roles (org_type, organization_id, name, description, is_preset)
  values ('brand', p_brand_id, 'Warehouse manager', 'Prepares orders and dispatches them to the hub. No invoices or payments.', true) returning id into v_id;
  insert into role_permissions (role_id, permission)
  select v_id, unnest(array['orders.view', 'orders.prepare', 'dispatch.view', 'dispatch.create', 'inventory.view', 'inventory.manage']);

  return v_staff;
end $$;
revoke all on function _create_brand_presets(uuid) from public, anon, authenticated;

create function _organizations_brand_presets() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'brand' then perform _create_brand_presets(new.id); end if;
  return new;
end $$;

create trigger organizations_brand_presets after insert on organizations
  for each row execute function _organizations_brand_presets();

do $$
declare r record; v_staff uuid; v_id uuid;
begin
  -- Brands: presets, and existing staff keep today's access via "Staff".
  for r in select id from organizations where type = 'brand' loop
    v_staff := _create_brand_presets(r.id);
    insert into rbac050_backup (kind, name) select 'role_created', id::text from roles where organization_id = r.id;
    insert into rbac050_backup_memberships (membership_id, old_role, old_role_id)
    select id, role::text, role_id from memberships where organization_id = r.id and role = 'brand_staff'
    on conflict do nothing;
    update memberships set role_id = v_staff where organization_id = r.id and role = 'brand_staff' and role_id is null;
  end loop;

  -- KBB: two focused starter roles next to "KBB agent".
  for r in select id from organizations where type = 'partner' loop
    insert into roles (org_type, organization_id, name, description, is_preset)
    values ('partner', r.id, 'Confirmation team', 'Calls customers to confirm orders.', true) returning id into v_id;
    insert into rbac050_backup (kind, name) values ('role_created', v_id::text);
    insert into role_permissions (role_id, permission)
    select v_id, unnest(array['orders.view', 'orders.add_note', 'orders.cancel', 'confirmations.view', 'confirmations.manage']);

    insert into roles (org_type, organization_id, name, description, is_preset)
    values ('partner', r.id, 'Delivery team', 'Receives shipments and delivers orders, collecting cash.', true) returning id into v_id;
    insert into rbac050_backup (kind, name) values ('role_created', v_id::text);
    insert into role_permissions (role_id, permission)
    select v_id, unnest(array['orders.view', 'orders.view_money', 'orders.hold', 'orders.add_note',
                              'shipments.view', 'shipments.receive', 'bd.receive', 'discrepancies.view', 'inventory.view',
                              'deliveries.view', 'deliveries.manage']);
  end loop;
end $$;

-- ---------- 6. Role management (company admins + V360 admins) --------------

create function save_org_role(p_id uuid, p_org_id uuid, p_name text, p_description text, p_permissions text[])
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid := p_id;
  v_org  uuid := p_org_id;
  v_type org_type;
  v_bad  text;
begin
  if v_id is not null then
    select organization_id into v_org from roles where id = v_id;
    if not found then raise exception 'Role not found'; end if;
  end if;
  if v_org is null or not can_manage_org(v_org) then raise exception 'You can''t manage roles for this organization'; end if;
  select type into v_type from organizations where id = v_org;
  if v_type not in ('v360', 'partner', 'brand') then raise exception 'Roles aren''t available for this organization'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the role a name'; end if;

  if v_id is null then
    insert into roles (org_type, organization_id, name, description)
    values (v_type, v_org, trim(p_name), nullif(trim(p_description), '')) returning id into v_id;
  else
    update roles set name = trim(p_name), description = nullif(trim(p_description), ''), updated_at = now() where id = v_id;
  end if;

  select string_agg(x, ', ') into v_bad
  from unnest(coalesce(p_permissions, '{}')) x
  where not exists (select 1 from permissions p where p.key = x and v_type::text = any(p.applies_to));
  if v_bad is not null then raise exception 'Not valid for this role: %', v_bad; end if;

  delete from role_permissions where role_id = v_id;
  insert into role_permissions (role_id, permission) select distinct v_id, x from unnest(coalesce(p_permissions, '{}')) x;
  return v_id;
exception when unique_violation then
  raise exception 'A role called "%" already exists', trim(p_name);
end $$;

revoke all on function save_org_role(uuid, uuid, text, text, text[]) from public, anon;
grant execute on function save_org_role(uuid, uuid, text, text, text[]) to authenticated;

-- 049's save_role(org_type) keeps working for the current portal build.
select _r50_backup_fn('save_role');
create or replace function save_role(p_id uuid, p_org_type org_type, p_name text, p_description text, p_permissions text[])
returns uuid language plpgsql security definer set search_path = public as $$
begin
  return save_org_role(p_id,
    case when p_id is null then (select id from organizations where type = p_org_type order by created_at limit 1) end,
    p_name, p_description, p_permissions);
end $$;

select _r50_backup_fn('delete_role');
create or replace function delete_role(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_n int;
begin
  select organization_id into v_org from roles where id = p_id;
  if not found then raise exception 'Role not found'; end if;
  if not can_manage_org(v_org) then raise exception 'You can''t manage roles for this organization'; end if;
  select count(*) into v_n from memberships where role_id = p_id;
  if v_n > 0 then
    raise exception '% user(s) still have this role. Give them another role first.', v_n;
  end if;
  delete from roles where id = p_id;
end $$;

-- ---------- 7. Brand actions gated by permission ---------------------------

-- Status moves by brand staff
select _r50_patch('change_order_status', jsonb_build_array(jsonb_build_array(
  '  if (v_actor = ''v360'' and not v360_can(transition_perm(p_to)))',
  '  if v_actor = ''brand'' and not brand_can(o.brand_id, brand_transition_perm(p_to)) then
    raise exception ''Your role doesn''''t allow this change'';
  end if;
  if (v_actor = ''v360'' and not v360_can(transition_perm(p_to)))')));

select _r50_patch('brand_update_order', jsonb_build_array(jsonb_build_array(
  'if v_actor not in (''brand'', ''v360'') then raise exception ''You cannot edit this order''; end if;',
  'if v_actor not in (''brand'', ''v360'') then raise exception ''You cannot edit this order''; end if;
  if v_actor = ''brand'' and not brand_can(o.brand_id, ''orders.edit_customer'') then
    raise exception ''Your role doesn''''t allow editing customer details'';
  end if;')));

select _r50_patch('create_inbound_batch', jsonb_build_array(jsonb_build_array(
  'if actor_group_for(v_brand) not in (''brand'', ''v360'') then raise exception ''You cannot dispatch these orders''; end if;',
  'if actor_group_for(v_brand) not in (''brand'', ''v360'') then raise exception ''You cannot dispatch these orders''; end if;
  if actor_group_for(v_brand) = ''brand'' and not brand_can(v_brand, ''dispatch.create'') then
    raise exception ''Your role doesn''''t allow dispatching orders'';
  end if;')));

select _r50_patch('brand_confirm_order', jsonb_build_array(jsonb_build_array(
  'if actor_group_for(o.brand_id) not in (''brand'', ''v360'') then',
  'if actor_group_for(o.brand_id) = ''brand'' and not brand_can(o.brand_id, ''orders.confirm'') then
    raise exception ''Your role doesn''''t allow confirming orders'';
  end if;
  if actor_group_for(o.brand_id) = ''v360'' and not v360_can(''orders.override_status'') then
    raise exception ''Your role doesn''''t allow acting for a brand'';
  end if;
  if actor_group_for(o.brand_id) not in (''brand'', ''v360'') then')));

select _r50_patch('brand_mark_preparing', jsonb_build_array(jsonb_build_array(
  'if actor_group_for(o.brand_id) not in (''brand'', ''v360'') then',
  'if actor_group_for(o.brand_id) = ''brand'' and not brand_can(o.brand_id, ''orders.prepare'') then
      raise exception ''Your role doesn''''t allow preparing orders'';
    end if;
    if actor_group_for(o.brand_id) = ''v360'' and not v360_can(''orders.override_status'') then
      raise exception ''Your role doesn''''t allow acting for a brand'';
    end if;
    if actor_group_for(o.brand_id) not in (''brand'', ''v360'') then')));

select _r50_patch('brand_import_order', jsonb_build_array(jsonb_build_array(
  'if actor_group_for(p_brand_id) not in (''brand'', ''v360'') then',
  'if actor_group_for(p_brand_id) = ''brand'' and not brand_can(p_brand_id, ''orders.import'') then
    raise exception ''Your role doesn''''t allow importing orders'';
  end if;
  if actor_group_for(p_brand_id) = ''v360'' and not v360_can(''orders.override_status'') then
    raise exception ''Your role doesn''''t allow acting for a brand'';
  end if;
  if actor_group_for(p_brand_id) not in (''brand'', ''v360'') then')));

select _r50_patch('upsert_inventory', '[["if not is_v360() and not is_brand_member(p_brand_id) then", "if not v360_can(''orders.override_status'') and not brand_can(p_brand_id, ''inventory.manage'') then"]]');
select _r50_patch('delete_inventory', '[["if not is_v360() and not is_brand_member(p_brand_id) then", "if not v360_can(''orders.override_status'') and not brand_can(p_brand_id, ''inventory.manage'') then"]]');

select _r50_patch('disconnect_shopify', '[["if v_role <> ''brand_owner'' and not is_v360() then", "if not brand_can(p_brand_id, ''shopify.manage'') and not v360_can(''brands.settings'') then"]]');

select _r50_patch('send_order_message', jsonb_build_array(
  jsonb_build_array('if is_v360() or is_partner() then', 'if v360_can(''orders.messages'') or partner_can(''orders.messages'') then'),
  jsonb_build_array('elsif is_brand_member(v_brand_id) then', 'elsif brand_can(v_brand_id, ''orders.messages'') then')));

-- 049 gap: Payments figures were readable by any V360 member and every brand member.
-- Only exists if the brand project's 009_money was applied; skipped otherwise.
select _r50_patch('order_money_overview', jsonb_build_array(
  jsonb_build_array('v_is_v360 := is_v360();', 'v_is_v360 := v360_can(''money.view'');'),
  jsonb_build_array('v_is_partner := is_partner();', 'v_is_partner := partner_can(''money.view'');'),
  jsonb_build_array('or o.brand_id in (select unnest(my_brand_ids()))', 'or brand_can(o.brand_id, ''money.view'')')), true);

-- ---------- 8. Policies -------------------------------------------------------

-- Roles: each company sees its own; company admins (and V360 admins) edit them.
select _r50_policy('roles', 'roles_read',
  'is_v360_admin() or organization_id in (select m.organization_id from memberships m where m.user_id = auth.uid())');
select _r50_policy('roles', 'roles_write', 'can_manage_org(organization_id)', 'can_manage_org(organization_id)');
select _r50_policy('role_permissions', 'role_permissions_read', 'exists (select 1 from roles r where r.id = role_id)');
select _r50_policy('role_permissions', 'role_permissions_write',
  'exists (select 1 from roles r where r.id = role_id and can_manage_org(r.organization_id))',
  'exists (select 1 from roles r where r.id = role_id and can_manage_org(r.organization_id))');

-- Team pages for company admins
select _r50_policy('memberships', 'membership_read', 'user_id = auth.uid() or is_v360() or can_manage_org(organization_id)');
select _r50_policy('memberships', 'membership_write', 'can_manage_org(organization_id)', 'can_manage_org(organization_id)');
select _r50_policy('profiles', 'profile_read',
  'id = auth.uid() or is_v360()
   or exists (select 1 from memberships m where m.user_id = profiles.id and can_manage_org(m.organization_id))');

-- Brand money & documents
select _r50_policy('invoices', 'invoices_read',
  'v360_can(''invoices.view'') or partner_can(''invoices.view'')
   or (invoice_type = ''brand_payout'' and brand_id is not null and brand_can(brand_id, ''invoices.view''))');
select _r50_policy('brand_shipping_invoices', 'brand_shipping_invoices_read',
  'v360_can(''invoices.view'') or brand_can(brand_id, ''invoices.view'')');
select _r50_policy('brand_money_settings', 'Brands read own brand_money_settings',
  'brand_can(brand_id, ''money.view'') or brand_can(brand_id, ''invoices.view'')');
-- 049 gap: brands lost read access to their own statements.
select _r50_policy('settlements', 'settlements_read',
  'v360_can(''money.view'') or partner_can(''money.view'') or brand_can(brand_id, ''money.view'')');
select _r50_policy('settlement_lines', 'settlement_lines_read',
  'v360_can(''money.view'') or partner_can(''money.view'')
   or exists (select 1 from settlements s where s.id = settlement_id and brand_can(s.brand_id, ''money.view''))');
-- 049 gap: KBB money per order was readable by any V360 member.
select _r50_policy('order_kbb_money', 'kbb_money_read', 'v360_can(''money.view'') or partner_can(''money.view'')', null, true);

-- Brand private notes, messages, stock
select _r50_policy('order_internal_notes', 'internal_notes_read',
  '(role = ''admin'' and v360_can(''orders.internal_notes''))
   or (role = ''kbb'' and partner_can(''orders.internal_notes''))
   or (role = ''brand'' and exists (select 1 from orders o where o.id = order_id and brand_can(o.brand_id, ''orders.internal_notes'')))');
select _r50_policy('order_internal_notes', 'internal_notes_write',
  '(role = ''admin'' and v360_can(''orders.internal_notes''))
   or (role = ''kbb'' and partner_can(''orders.internal_notes''))
   or (role = ''brand'' and exists (select 1 from orders o where o.id = order_id and brand_can(o.brand_id, ''orders.internal_notes'')))',
  '(role = ''admin'' and v360_can(''orders.internal_notes''))
   or (role = ''kbb'' and partner_can(''orders.internal_notes''))
   or (role = ''brand'' and exists (select 1 from orders o where o.id = order_id and brand_can(o.brand_id, ''orders.internal_notes'')))');
select _r50_policy('order_messages', 'msg_read',
  'is_v360() or exists (select 1 from orders o where o.id = order_id and brand_can(o.brand_id, ''orders.messages''))', null, true);
select _r50_policy('brand_inventory', 'inventory_read', 'is_v360() or brand_can(brand_id, ''inventory.view'')', null, true);

-- ---------- Done ---------------------------------------------------------------

drop function _r50_backup_fn(text);
drop function _r50_patch(text, jsonb, boolean);
drop function _r50_policy(text, text, text, text, boolean);

commit;
