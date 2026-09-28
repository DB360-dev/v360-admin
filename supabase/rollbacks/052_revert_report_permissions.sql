-- ROLLBACK for migrations/052_report_permissions.sql
-- Removes the report permissions (and every role's grants of them) and puts
-- the 050 version of _create_brand_presets back. Run by hand in the SQL editor.

begin;

delete from permissions where area = 'Reports';   -- role_permissions rows cascade

create or replace function _create_brand_presets(p_brand_id uuid) returns uuid
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

commit;
