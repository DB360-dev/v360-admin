-- =====================================================================
-- 049_roles_permissions.sql — Custom roles with per-action permissions
--
-- V360 admins build roles (e.g. "Warehouse", "Accounts") from a fixed
-- catalog of permissions, then give each V360 or KBB user one role.
--
--   * V360 'admin' members stay built-in: full access, no role needed.
--     Team & roles and Shopify app credentials stay admin-only.
--   * Every other V360 member ('operator') and every KBB member
--     ('partner_agent') gets their permissions from memberships.role_id.
--   * is_v360() / is_partner() still say WHICH SIDE a user is on (the
--     workflow depends on it). v360_can(perm) / partner_can(perm) add
--     WHAT they may do, and every action function and money policy now
--     checks them.
--
-- Replaces the fixed 'warehouse' role from 047/048: warehouse members are
-- moved to the "Warehouse" preset role. Works whether or not 048 (or its
-- old revert) was applied.
--
-- Everything this migration changes is saved in rbac_backup /
-- rbac_backup_memberships so supabase/rollbacks/049_revert_roles_permissions.sql
-- can put it back exactly.
-- =====================================================================

-- ---------- Backups (read by the rollback script) --------------------

create table rbac_backup (
  seq         serial primary key,
  kind        text not null,          -- function | policy | transition | constraint
  name        text not null,
  extra       text,
  definition  text,
  definition2 text
);
create table rbac_backup_memberships (
  membership_id uuid primary key,
  old_role      text not null
);
-- No policies: only the SQL editor / service role can touch these.
alter table rbac_backup enable row level security;
alter table rbac_backup_memberships enable row level security;

-- ---------- Catalog ----------------------------------------------------

create table permissions (
  key         text primary key,
  area        text not null,
  label       text not null,
  description text,
  applies_to  text[] not null,        -- 'v360' and/or 'partner' (KBB)
  sort        int not null
);

insert into permissions (key, area, label, description, applies_to, sort) values
  ('orders.view',            'Orders', 'View all orders',             'Open the All orders list and order pages.',                          '{v360,partner}', 100),
  ('orders.view_money',      'Orders', 'See money amounts',           'Order totals, prices, COD amounts and payment status.',               '{v360,partner}', 101),
  ('orders.hold',            'Orders', 'Hold and resume orders',      null,                                                                 '{v360,partner}', 102),
  ('orders.cancel',          'Orders', 'Cancel orders',               null,                                                                 '{v360,partner}', 103),
  ('orders.add_note',        'Orders', 'Add notes to orders',         'Notes that show in the order timeline.',                             '{v360,partner}', 104),
  ('orders.internal_notes',  'Orders', 'Private internal notes',      'Read and write the private notes for their team.',                    '{v360,partner}', 105),
  ('orders.messages',        'Orders', 'Message brands',              'Send messages to the brand on an order.',                            '{v360,partner}', 106),
  ('orders.edit_customer',   'Orders', 'Edit customer details',       null,                                                                 '{v360}',         107),
  ('orders.return_decision', 'Orders', 'Decide on returns',           'Restock, send back or write off returned items.',                    '{v360}',         108),
  ('orders.override_status', 'Orders', 'Override order status',       'Force any status, and act on behalf of a brand.',                    '{v360}',         109),

  ('confirmations.view',     'Confirmations', 'Open confirmations queue', null,                                                             '{v360,partner}', 200),
  ('confirmations.manage',   'Confirmations', 'Record confirmation calls', 'Confirmed, unreachable, needs amendment.',                      '{v360,partner}', 201),

  ('hub.view',               'Hub receiving', 'Open hub receiving',     null,                                                               '{v360}',         300),
  ('hub.receive',            'Hub receiving', 'Receive parcels at the hub', 'Count and weigh items, accept BD-stock orders, mark ready for shipment.', '{v360}', 301),

  ('shipments.view',          'Shipments', 'View shipments',           null,                                                                '{v360,partner}', 400),
  ('shipments.create',        'Shipments', 'Create shipments',         null,                                                                '{v360}',         401),
  ('shipments.edit_orders',   'Shipments', 'Add and remove orders',    null,                                                                '{v360}',         402),
  ('shipments.edit_details',  'Shipments', 'Edit carrier and tracking', null,                                                               '{v360}',         403),
  ('shipments.update_status', 'Shipments', 'Dispatch and update status', 'Hand to carrier, arrived in Bangladesh, etc.',                    '{v360}',         404),
  ('shipments.freight_weights','Shipments', 'Enter freight weights',   null,                                                                '{v360}',         405),
  ('shipments.receive',       'Shipments', 'Confirm shipment received', 'Mark a shipment as received by KBB.',                             '{partner}',      406),

  ('bd.receive',              'Discrepancies', 'Check items received in Bangladesh', null,                                                  '{v360,partner}', 500),
  ('discrepancies.view',      'Discrepancies', 'View discrepancies',   null,                                                                '{v360,partner}', 501),
  ('discrepancies.override',  'Discrepancies', 'Override receiving discrepancies', null,                                                    '{v360}',         502),
  ('discrepancies.resolve',   'Discrepancies', 'Mark discrepancies resolved', null,                                                         '{v360}',         503),

  ('inventory.view',          'Inventory', 'View inventory',           null,                                                                '{v360,partner}', 600),

  ('deliveries.view',         'Deliveries', 'Open deliveries queue',   null,                                                                '{v360,partner}', 700),
  ('deliveries.manage',       'Deliveries', 'Manage deliveries',       'Tracking, out for delivery, delivered, failed, returned.',          '{v360,partner}', 701),

  ('invoices.view',           'Invoices', 'View invoices',             null,                                                                '{v360,partner}', 800),
  ('invoices.create',         'Invoices', 'Generate invoices',         null,                                                                '{v360,partner}', 801),
  ('invoices.payment_status', 'Invoices', 'Change invoice payment status', null,                                                            '{v360,partner}', 802),
  ('invoices.recalculate',    'Invoices', 'Recalculate shipping invoices', null,                                                            '{v360}',         803),
  ('invoices.delete',         'Invoices', 'Delete invoices',           null,                                                                '{v360}',         804),

  ('money.view',              'Money', 'View money',                   'Payables, statements and the KBB account.',                         '{v360,partner}', 900),
  ('money.record_payment',    'Money', 'Record KBB payments',          null,                                                                '{v360}',         901),
  ('money.statements',        'Money', 'Create statements and mark paid', null,                                                             '{v360}',         902),
  ('money.settings',          'Money', 'Change money settings',        'Commissions, freight rate, invoice company name.',                  '{v360}',         903),

  ('brands.view',             'Brands', 'View brands',                 null,                                                                '{v360}',         1000),
  ('brands.approve',          'Brands', 'Approve and reject brands',   null,                                                                '{v360}',         1001),
  ('brands.settings',         'Brands', 'Edit brand settings',         'Brand commission / freight settings and Shopify connections.',      '{v360}',         1002),

  ('fx.view',                 'FX rates', 'View FX rates',             null,                                                                '{v360}',         1100),
  ('fx.manage',               'FX rates', 'Add and edit FX rates',     null,                                                                '{v360}',         1101),

  ('webhooks.view',           'Shopify sync', 'View Shopify sync',     null,                                                                '{v360}',         1200),
  ('webhooks.replay',         'Shopify sync', 'Retry failed imports',  null,                                                                '{v360}',         1201),

  ('activity.view',           'Activity', 'View activity log',         null,                                                                '{v360}',         1300);

-- ---------- Roles --------------------------------------------------------

create table roles (
  id          uuid primary key default gen_random_uuid(),
  org_type    org_type not null check (org_type in ('v360', 'partner')),
  name        text not null check (length(trim(name)) between 1 and 60),
  description text,
  is_preset   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index roles_org_type_name_key on roles (org_type, lower(name));

create table role_permissions (
  role_id    uuid not null references roles(id) on delete cascade,
  permission text not null references permissions(key) on delete cascade,
  primary key (role_id, permission)
);

alter table memberships add column role_id uuid references roles(id) on delete restrict;
create index on memberships (role_id);

-- A membership's role must be for its organization's side; admins need none.
create function _membership_role_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org_type  org_type;
  v_role_type org_type;
begin
  if new.role_id is null then return new; end if;
  select type into v_org_type from organizations where id = new.organization_id;
  select org_type into v_role_type from roles where id = new.role_id;
  if v_org_type is distinct from v_role_type then
    raise exception 'That role is for % users, not %', v_role_type, v_org_type;
  end if;
  if new.role = 'admin' then new.role_id := null; end if;   -- admins have full access
  return new;
end $$;

create trigger memberships_role_check before insert or update of role_id, role, organization_id on memberships
  for each row execute function _membership_role_check();

-- ---------- Permission checks ------------------------------------------

create function v360_can(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'v360' and o.is_active
      and (m.role = 'admin'
           or exists (select 1 from role_permissions rp where rp.role_id = m.role_id and rp.permission = p_perm))
  )
$$;

create function partner_can(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'partner' and o.is_active
      and exists (select 1 from role_permissions rp where rp.role_id = m.role_id and rp.permission = p_perm)
  )
$$;

-- Which permission a change_order_status move needs (the UI uses the same map).
create function transition_perm(p_to order_status) returns text
language sql immutable as $$
  select case
    when p_to in ('confirmation_pending', 'confirmed', 'customer_unreachable', 'needs_amendment') then 'confirmations.manage'
    when p_to = 'cancelled' then 'orders.cancel'
    when p_to = 'ready_for_shipment' then 'hub.receive'
    when p_to in ('preparing_for_delivery', 'out_for_delivery', 'delivery_failed', 'returned') then 'deliveries.manage'
    else 'orders.override_status' end
$$;

revoke all on function v360_can(text), partner_can(text), transition_perm(order_status) from public, anon;
grant execute on function v360_can(text), partner_can(text), transition_perm(order_status) to authenticated;

-- ---------- Role management (V360 admins only) -------------------------

create function save_role(p_id uuid, p_org_type org_type, p_name text, p_description text, p_permissions text[])
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid := p_id;
  v_type org_type;
  v_bad  text;
begin
  if not is_v360_admin() then raise exception 'Only V360 admins can manage roles'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the role a name'; end if;

  if v_id is null then
    if p_org_type not in ('v360', 'partner') then raise exception 'Roles are for V360 or KBB users'; end if;
    insert into roles (org_type, name, description)
    values (p_org_type, trim(p_name), nullif(trim(p_description), ''))
    returning id, org_type into v_id, v_type;
  else
    update roles set name = trim(p_name), description = nullif(trim(p_description), ''), updated_at = now()
    where id = v_id returning org_type into v_type;
    if not found then raise exception 'Role not found'; end if;
  end if;

  select string_agg(x, ', ') into v_bad
  from unnest(coalesce(p_permissions, '{}')) x
  where not exists (select 1 from permissions p where p.key = x and v_type::text = any(p.applies_to));
  if v_bad is not null then raise exception 'Not valid for this role: %', v_bad; end if;

  delete from role_permissions where role_id = v_id;
  insert into role_permissions (role_id, permission)
  select distinct v_id, x from unnest(coalesce(p_permissions, '{}')) x;
  return v_id;
exception when unique_violation then
  raise exception 'A role called "%" already exists', trim(p_name);
end $$;

create function delete_role(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not is_v360_admin() then raise exception 'Only V360 admins can manage roles'; end if;
  select count(*) into v_n from memberships where role_id = p_id;
  if v_n > 0 then
    raise exception '% user(s) still have this role. Give them another role first.', v_n;
  end if;
  delete from roles where id = p_id;
end $$;

revoke all on function save_role(uuid, org_type, text, text, text[]), delete_role(uuid) from public, anon;
grant execute on function save_role(uuid, org_type, text, text, text[]), delete_role(uuid) to authenticated;

alter table permissions enable row level security;
alter table roles enable row level security;
alter table role_permissions enable row level security;
create policy permissions_read on permissions for select to authenticated using (true);
create policy roles_read on roles for select to authenticated using (is_v360() or is_partner());
create policy roles_write on roles for all to authenticated using (is_v360_admin()) with check (is_v360_admin());
create policy role_permissions_read on role_permissions for select to authenticated using (is_v360() or is_partner());
create policy role_permissions_write on role_permissions for all to authenticated using (is_v360_admin()) with check (is_v360_admin());
grant select on permissions, roles, role_permissions to authenticated;

-- ---------- Preset roles (same access people have today) ---------------

do $$
declare v_op uuid; v_wh uuid; v_kbb uuid;
begin
  insert into roles (org_type, name, description, is_preset) values
    ('v360', 'Operator', 'Day-to-day V360 operations. Everything except brand approval, brand settings and private notes.', true)
    returning id into v_op;
  insert into role_permissions (role_id, permission)
  select v_op, key from permissions
  where 'v360' = any(applies_to)
    and key not in ('brands.approve', 'brands.settings', 'orders.internal_notes');

  insert into roles (org_type, name, description, is_preset) values
    ('v360', 'Warehouse', 'Lahore hub staff: receive parcels and build shipments. No money or invoices.', true)
    returning id into v_wh;
  insert into role_permissions (role_id, permission)
  select v_wh, unnest(array[
    'orders.view', 'orders.hold', 'orders.add_note', 'orders.messages',
    'hub.view', 'hub.receive',
    'shipments.view', 'shipments.create', 'shipments.edit_orders', 'shipments.edit_details', 'shipments.update_status',
    'discrepancies.view', 'inventory.view']);

  insert into roles (org_type, name, description, is_preset) values
    ('partner', 'KBB agent', 'KBB staff in Bangladesh: confirmation calls, receiving shipments, deliveries.', true)
    returning id into v_kbb;
  insert into role_permissions (role_id, permission)
  select v_kbb, unnest(array[
    'orders.view', 'orders.view_money', 'orders.hold', 'orders.cancel', 'orders.add_note', 'orders.internal_notes', 'orders.messages',
    'confirmations.view', 'confirmations.manage',
    'shipments.view', 'shipments.receive',
    'bd.receive', 'discrepancies.view', 'inventory.view',
    'deliveries.view', 'deliveries.manage',
    'invoices.view', 'money.view']);

  -- Give existing members the preset matching their current access.
  insert into rbac_backup_memberships (membership_id, old_role)
  select m.id, m.role::text from memberships m join organizations o on o.id = m.organization_id
  where (o.type = 'v360' and m.role::text in ('operator', 'warehouse'))
     or (o.type = 'partner');

  update memberships m set role_id = v_wh, role = 'operator'
  from organizations o where o.id = m.organization_id and o.type = 'v360' and m.role::text = 'warehouse';
  update memberships m set role_id = v_op
  from organizations o where o.id = m.organization_id and o.type = 'v360' and m.role::text = 'operator' and m.role_id is null;
  update memberships m set role_id = v_kbb
  from organizations o where o.id = m.organization_id and o.type = 'partner';
end $$;

-- ---------- Undo 048's fixed warehouse role --------------------------

do $$
declare r record;
begin
  -- Back up the helpers first (restored in this order by the rollback).
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('is_v360_warehouse', 'is_v360', 'actor_group_for')
           order by array_position(array['is_v360_warehouse', 'is_v360', 'actor_group_for'], p.proname::text)
  loop
    insert into rbac_backup (kind, name, definition) values ('function', r.proname, pg_get_functiondef(r.oid));
  end loop;

  insert into rbac_backup (kind, name, definition)
  select 'constraint', 'status_transitions_actor_check', pg_get_constraintdef(c.oid)
  from pg_constraint c where c.conname = 'status_transitions_actor_check' and c.conrelid = 'status_transitions'::regclass;
  insert into rbac_backup (kind, name, extra, definition)
  select 'transition', from_status::text, to_status::text, actor from status_transitions where actor = 'warehouse';
end $$;

-- is_v360() is "any V360 member" again: permissions now decide what they can do.
create or replace function is_v360() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.type = 'v360' and o.is_active
  )
$$;

create or replace function actor_group_for(p_brand_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when is_v360() then 'v360'
    when is_partner() then 'partner'
    when is_brand_member(p_brand_id) then 'brand'
    else null end
$$;

delete from status_transitions where actor = 'warehouse';
alter table status_transitions drop constraint if exists status_transitions_actor_check;
alter table status_transitions add constraint status_transitions_actor_check
  check (actor in ('partner', 'brand', 'v360'));

-- ---------- Gate every action function by permission -------------------
-- Rewrites each function from its live definition (keeps later fixes),
-- after backing it up. Fails loudly if the expected text isn't there.

create function _rbac_patch(p_name text, p_pairs jsonb, p_strict boolean default true)
returns void language plpgsql as $$
declare
  r      record;
  v_def  text;
  v_base text;
  v_new  text;
  v_pair jsonb;
  v_n    int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = p_name
  loop
    v_n := v_n + 1;
    v_def := pg_get_functiondef(r.oid);
    insert into rbac_backup (kind, name, definition) values ('function', p_name, v_def);
    v_base := replace(v_def, '(is_v360() or is_v360_warehouse())', 'is_v360()');   -- undo 048
    v_new := v_base;
    for v_pair in select value from jsonb_array_elements(p_pairs) loop
      if position(v_pair->>0 in v_new) = 0 and coalesce(v_pair->>2, '') <> 'optional' then
        raise exception '%: expected text not found: %', p_name, v_pair->>0;
      end if;
      v_new := replace(v_new, v_pair->>0, v_pair->>1);
    end loop;
    if v_new = v_base then
      raise exception '%: no role check found to gate', p_name;
    end if;
    if p_strict and (position('is_v360()' in v_new) > 0 or position('is_partner()' in v_new) > 0
                     or position('is_v360_admin()' in v_new) > 0 or position('is_v360_warehouse()' in v_new) > 0) then
      raise exception '%: has a role check this migration does not map', p_name;
    end if;
    execute v_new;
  end loop;
  if v_n = 0 then raise exception 'Function % not found', p_name; end if;
end $$;

-- Same permission for both V360 and KBB callers.
create function _rbac_gate(p_name text, p_perm text) returns void language plpgsql as $$
begin
  perform _rbac_patch(p_name, jsonb_build_array(
    jsonb_build_array('is_v360()', format('v360_can(%L)', p_perm), 'optional'),
    jsonb_build_array('is_partner()', format('partner_can(%L)', p_perm), 'optional')));
end $$;

select _rbac_gate('hold_order', 'orders.hold');
select _rbac_gate('resume_order', 'orders.hold');
select _rbac_gate('add_order_note', 'orders.add_note');
select _rbac_gate('admin_override_status', 'orders.override_status');
select _rbac_gate('set_return_disposition', 'orders.return_decision');
select _rbac_gate('receive_order', 'hub.receive');
select _rbac_gate('accept_bd_stock_order', 'hub.receive');
select _rbac_gate('create_shipment', 'shipments.create');
select _rbac_gate('create_shipment_with_orders', 'shipments.create');
select _rbac_gate('add_orders_to_shipment', 'shipments.edit_orders');
select _rbac_gate('remove_order_from_shipment', 'shipments.edit_orders');
select _rbac_gate('set_shipment_brand_weight', 'shipments.freight_weights');
select _rbac_gate('set_order_freight_weight', 'shipments.freight_weights');
select _rbac_gate('bd_save_order_receiving', 'bd.receive');
select _rbac_gate('set_discrepancy_resolved', 'discrepancies.resolve');
select _rbac_gate('set_delivery_tracking', 'deliveries.manage');
select _rbac_gate('mark_delivered', 'deliveries.manage');
select _rbac_gate('save_generated_invoice', 'invoices.create');
select _rbac_gate('create_brand_payout_invoice', 'invoices.create');
select _rbac_gate('set_invoice_payment_status', 'invoices.payment_status');
select _rbac_gate('set_shipment_invoice_payment_status', 'invoices.payment_status');
select _rbac_gate('set_brand_shipping_invoice_payment_status', 'invoices.payment_status');
select _rbac_gate('regenerate_brand_shipping_invoices', 'invoices.recalculate');
select _rbac_gate('delete_invoice', 'invoices.delete');
select _rbac_gate('delete_brand_shipping_invoice', 'invoices.delete');
select _rbac_gate('kbb_account_overview', 'money.view');
select _rbac_gate('brand_payable_overview', 'money.view');
select _rbac_gate('record_kbb_payment', 'money.record_payment');
select _rbac_gate('create_brand_settlement', 'money.statements');
select _rbac_gate('mark_settlement_paid', 'money.statements');
select _rbac_gate('update_money_settings', 'money.settings');
select _rbac_gate('replay_webhook', 'webhooks.replay');

-- V360 moves shipments forward; KBB only confirms receipt.
select _rbac_patch('set_shipment_status', jsonb_build_array(
  jsonb_build_array('if is_v360() then', 'if v360_can(''shipments.update_status'') then'),
  jsonb_build_array('elsif is_partner() and p_to', 'elsif partner_can(''shipments.receive'') and p_to')));

-- Overriding a discrepancy is its own permission.
select _rbac_patch('bd_confirm_shipment_receiving', jsonb_build_array(
  -- 'optional': the old one-argument overload from 019 has no override flag
  jsonb_build_array('if p_override and not is_v360() then', 'if p_override and not v360_can(''discrepancies.override'') then', 'optional'),
  jsonb_build_array('is_v360()', 'v360_can(''bd.receive'')', 'optional'),
  jsonb_build_array('is_partner()', 'partner_can(''bd.receive'')', 'optional')));

-- Admin-only until now.
select _rbac_patch('approve_brand', '[["is_v360_admin()", "v360_can(''brands.approve'')"]]');
select _rbac_patch('reject_brand', '[["is_v360_admin()", "v360_can(''brands.approve'')"]]');
select _rbac_patch('guard_org_approval', '[["is_v360_admin()", "v360_can(''brands.approve'')"]]');
select _rbac_patch('save_brand_money_settings', '[["is_v360_admin()", "v360_can(''brands.settings'')"]]');

-- Status moves: the permission depends on the target status (transition_perm).
select _rbac_patch('change_order_status', jsonb_build_array(jsonb_build_array(
  '  if status_requires_dedicated_function(p_to) then',
  '  if (v_actor = ''v360'' and not v360_can(transition_perm(p_to)))
     or (v_actor = ''partner'' and not partner_can(transition_perm(p_to))) then
    raise exception ''Your role doesn''''t allow moving orders to "%"'', p_to;
  end if;

  if status_requires_dedicated_function(p_to) then')));

-- V360 editing customer details / dispatching on a brand's behalf.
select _rbac_patch('brand_update_order', jsonb_build_array(jsonb_build_array(
  'if v_actor not in (''brand'', ''v360'') then raise exception ''You cannot edit this order''; end if;',
  'if v_actor not in (''brand'', ''v360'') then raise exception ''You cannot edit this order''; end if;
  if v_actor = ''v360'' and not v360_can(''orders.edit_customer'') then
    raise exception ''Your role doesn''''t allow editing customer details'';
  end if;')));

select _rbac_patch('create_inbound_batch', jsonb_build_array(jsonb_build_array(
  'if actor_group_for(v_brand) not in (''brand'', ''v360'') then raise exception ''You cannot dispatch these orders''; end if;',
  'if actor_group_for(v_brand) not in (''brand'', ''v360'') then raise exception ''You cannot dispatch these orders''; end if;
  if actor_group_for(v_brand) = ''v360'' and not v360_can(''orders.override_status'') then
    raise exception ''Your role doesn''''t allow dispatching for a brand'';
  end if;')));

drop function _rbac_gate(text, text);
drop function _rbac_patch(text, jsonb, boolean);

-- ---------- Policies ---------------------------------------------------
-- Operational data (orders, shipments, parcels, weights) stays readable by
-- all V360/KBB staff; pages are hidden by permission in the portal.
-- Money data and every write are gated by permission here.

create function _rbac_policy(p_table text, p_policy text, p_using text, p_check text default null)
returns void language plpgsql as $$
declare v_qual text; v_check text;
begin
  select qual, with_check into v_qual, v_check from pg_policies
  where schemaname = 'public' and tablename = p_table and policyname = p_policy;
  if not found then raise exception 'Policy % on % not found', p_policy, p_table; end if;
  insert into rbac_backup (kind, name, extra, definition, definition2) values ('policy', p_table, p_policy, v_qual, v_check);
  execute format('alter policy %I on %I', p_policy, p_table)
    || case when p_using is not null then format(' using (%s)', p_using) else '' end
    || case when p_check is not null then format(' with check (%s)', p_check) else '' end;
end $$;

-- Identity-only reads (also clears 048's warehouse grants)
select _rbac_policy('organizations', 'org_read',
  'is_v360() or is_partner() or id in (select organization_id from memberships where user_id = auth.uid())');
select _rbac_policy('orders', 'orders_read', 'is_v360() or is_partner() or is_brand_member(brand_id)');
select _rbac_policy('inbound_batches', 'inbound_read', 'is_v360() or is_brand_member(brand_id)');
select _rbac_policy('shipments', 'shipments_read',
  'is_v360() or (is_partner() and status >= ''handed_to_carrier'')
   or exists (select 1 from orders o where o.shipment_id = shipments.id and is_brand_member(o.brand_id))');
select _rbac_policy('order_freight_weights', 'order_weight_read',
  'is_v360() or is_partner() or exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id))');
select _rbac_policy('bd_received_items', 'bd_receiving_select', 'is_v360() or is_partner()');

-- Writes
select _rbac_policy('shipments', 'shipments_update',
  'v360_can(''shipments.edit_details'')', 'v360_can(''shipments.edit_details'')');
select _rbac_policy('inbound_batches', 'inbound_update',
  'v360_can(''hub.receive'') or (is_brand_member(brand_id) and status = ''in_transit'')',
  'v360_can(''hub.receive'') or is_brand_member(brand_id)');
select _rbac_policy('bd_received_items', 'bd_receiving_write',
  'v360_can(''bd.receive'') or partner_can(''bd.receive'')', 'v360_can(''bd.receive'') or partner_can(''bd.receive'')');
select _rbac_policy('shopify_connections', 'shopify_write',
  'v360_can(''brands.settings'')', 'v360_can(''brands.settings'')');
select _rbac_policy('fx_rates', 'fx_insert', null, 'v360_can(''fx.manage'')');
select _rbac_policy('fx_rates', 'fx_update', 'v360_can(''fx.manage'')', 'v360_can(''fx.manage'')');
select _rbac_policy('webhook_events', 'webhook_read', 'v360_can(''webhooks.view'')');

-- Private notes: each side's notes need the permission
select _rbac_policy('order_internal_notes', 'internal_notes_read',
  '(role = ''admin'' and v360_can(''orders.internal_notes''))
   or (role = ''kbb'' and partner_can(''orders.internal_notes''))
   or (role = ''brand'' and exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)))');
select _rbac_policy('order_internal_notes', 'internal_notes_write',
  '(role = ''admin'' and v360_can(''orders.internal_notes''))
   or (role = ''kbb'' and partner_can(''orders.internal_notes''))
   or (role = ''brand'' and exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)))',
  '(role = ''admin'' and v360_can(''orders.internal_notes''))
   or (role = ''kbb'' and partner_can(''orders.internal_notes''))
   or (role = ''brand'' and exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)))');

-- Money
select _rbac_policy('invoices', 'invoices_read',
  'v360_can(''invoices.view'') or partner_can(''invoices.view'')
   or (invoice_type = ''brand_payout'' and brand_id is not null and is_brand_member(brand_id))');
select _rbac_policy('invoices', 'Invoices are manageable by staff',
  'v360_can(''invoices.create'') or partner_can(''invoices.create'')');
select _rbac_policy('brand_shipping_invoices', 'brand_shipping_invoices_read',
  'v360_can(''invoices.view'') or is_brand_member(brand_id)');
select _rbac_policy('kbb_payments', 'kbb_payments_read', 'v360_can(''money.view'') or partner_can(''money.view'')');
select _rbac_policy('settlements', 'settlements_read', 'v360_can(''money.view'') or partner_can(''money.view'')');
select _rbac_policy('settlement_lines', 'settlement_lines_read', 'v360_can(''money.view'') or partner_can(''money.view'')');
select _rbac_policy('brand_money_settings', 'V360 full access on brand_money_settings', 'v360_can(''brands.settings'')');

drop function _rbac_policy(text, text, text, text);

-- Invoice PDFs and money pages read brand commission settings.
create policy brand_money_settings_staff_read on brand_money_settings for select to authenticated
  using (v360_can('invoices.view') or v360_can('money.view'));

-- ---------- Retire the fixed warehouse helper --------------------------

drop function if exists is_v360_warehouse();
