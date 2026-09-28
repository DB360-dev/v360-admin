-- =====================================================================
-- READ-ONLY pre-flight for migrations/050_org_roles.sql
-- Paste into the Supabase SQL editor, run, and copy the result rows.
-- Changes nothing.
--
--   section = 'anchor'  -> text 050 needs to find (ok must be true)
--   section = 'policy'  -> policies 050 alters (ok must be true, or optional)
--   section = 'gap'     -> functions/policies still trusting plain
--                          membership (is_v360 / is_partner / brand member)
--                          that 050 does NOT gate yet
--   section = '049'     -> confirms 049 is in place
-- =====================================================================

with anchors(fn, needle) as (values
  ('change_order_status',  '  if (v_actor = ''v360'' and not v360_can(transition_perm(p_to)))'),
  ('brand_update_order',   'if v_actor not in (''brand'', ''v360'') then raise exception ''You cannot edit this order''; end if;'),
  ('create_inbound_batch', 'if actor_group_for(v_brand) not in (''brand'', ''v360'') then raise exception ''You cannot dispatch these orders''; end if;'),
  ('brand_confirm_order',  'if actor_group_for(o.brand_id) not in (''brand'', ''v360'') then'),
  ('brand_mark_preparing', 'if actor_group_for(o.brand_id) not in (''brand'', ''v360'') then'),
  ('brand_import_order',   'if actor_group_for(p_brand_id) not in (''brand'', ''v360'') then'),
  ('upsert_inventory',     'if not is_v360() and not is_brand_member(p_brand_id) then'),
  ('delete_inventory',     'if not is_v360() and not is_brand_member(p_brand_id) then'),
  ('disconnect_shopify',   'if v_role <> ''brand_owner'' and not is_v360() then'),
  ('send_order_message',   'if is_v360() or is_partner() then'),
  ('send_order_message',   'elsif is_brand_member(v_brand_id) then'),
  ('partner_can', 'rp.permission = p_perm'),
  ('save_role', 'is_v360_admin()'),
  ('delete_role', 'is_v360_admin()'),
  ('_membership_role_check', 'That role is for')
),
fns as (
  select p.proname::text as fn, p.oid, pg_get_function_identity_arguments(p.oid) as args, p.prosrc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
),
pols(tbl, pol, optional) as (values
  ('roles', 'roles_read', false), ('roles', 'roles_write', false),
  ('role_permissions', 'role_permissions_read', false), ('role_permissions', 'role_permissions_write', false),
  ('memberships', 'membership_read', false), ('memberships', 'membership_write', false), ('profiles', 'profile_read', false),
  ('invoices', 'invoices_read', false), ('brand_shipping_invoices', 'brand_shipping_invoices_read', false),
  ('brand_money_settings', 'Brands read own brand_money_settings', false),
  ('settlements', 'settlements_read', false), ('settlement_lines', 'settlement_lines_read', false),
  ('order_internal_notes', 'internal_notes_read', false), ('order_internal_notes', 'internal_notes_write', false),
  ('order_kbb_money', 'kbb_money_read', true), ('order_messages', 'msg_read', true), ('brand_inventory', 'inventory_read', true)
)
select 'anchor' as section, a.fn || coalesce('(' || f.args || ')', ' [function missing]') as item,
       coalesce(position(a.needle in f.prosrc) > 0, false) as ok, left(a.needle, 90) as detail
from anchors a left join fns f on f.fn = a.fn

union all
select 'policy', p.tbl || '.' || p.pol, (pp.policyname is not null) or p.optional,
       case when pp.policyname is null then 'missing' || case when p.optional then ' (optional, skipped)' else '' end
            else left(coalesce(pp.qual, pp.with_check), 160) end
from pols p left join pg_policies pp on pp.schemaname = 'public' and pp.tablename = p.tbl and pp.policyname = p.pol

union all
select 'gap', f.fn || '(' || f.args || ')', false,
       concat_ws(' ',
         case when f.prosrc like '%is_v360()%' then 'is_v360' end,
         case when f.prosrc like '%is_partner()%' then 'is_partner' end,
         case when f.prosrc like '%is_brand_member(%' then 'is_brand_member' end,
         case when f.prosrc like '%my_brand_ids()%' then 'my_brand_ids' end,
         case when f.prosrc like '%my_role_in(%' then 'my_role_in' end)
from fns f
where (f.prosrc like '%is_v360()%' or f.prosrc like '%is_partner()%' or f.prosrc like '%is_brand_member(%'
       or f.prosrc like '%my_brand_ids()%' or f.prosrc like '%my_role_in(%')
  and f.fn not in (   -- identity helpers / handled by 050 / reads that only need membership
    'is_v360', 'is_v360_admin', 'is_partner', 'is_brand_member', 'my_brand_ids', 'my_role_in', 'actor_group_for',
    'current_actor_label', 'v360_can', 'partner_can', 'brand_can', 'can_manage_org', 'order_has_note',
    'upsert_inventory', 'delete_inventory', 'disconnect_shopify', 'send_order_message', 'order_money_overview',
    'save_role', 'delete_role', 'save_org_role', 'mark_messages_read', 'brand_order_counts')

union all
select 'gap', 'policy ' || tablename || '.' || policyname, false, left(coalesce(qual, with_check), 160)
from pg_policies
where schemaname = 'public'
  and (coalesce(qual, '') ~ 'is_v360\(\)|is_partner\(\)|is_brand_member\(' or coalesce(with_check, '') ~ 'is_v360\(\)|is_partner\(\)|is_brand_member\(')

union all
select '049', 'roles / permissions / role_ids set',
       (select count(*) from roles) > 0 and to_regclass('public.rbac_backup') is not null,
       (select count(*) from roles) || ' roles, ' || (select count(*) from permissions) || ' permissions, '
       || (select count(*) from memberships where role_id is not null) || ' members with a role'

order by 1, 2;
