-- =====================================================================
-- 052_report_permissions.sql — One permission per report
--
-- Adds a "Reports" area to the permission catalog (each key = one report,
-- available to the sides in applies_to) and gives the starter roles
-- sensible defaults. Built-in admins (V360 admin, KBB admin, brand owner)
-- get every report of their own side automatically.
--
-- Reports read the same tables/views the portals already use, so the
-- existing access rules still decide which rows and money a person sees;
-- these keys decide who may open each report.
--
-- Safe to run more than once.
-- Rollback: supabase/rollbacks/052_revert_report_permissions.sql
-- =====================================================================

begin;

insert into permissions (key, area, label, description, applies_to, sort) values
  ('reports.order_register',        'Reports', 'Order register',              'Every order with its status and the date of each stage.',        '{v360,brand}',          2000),
  ('reports.status_snapshot',       'Reports', 'Status snapshot',             'Orders in each status, per brand.',                              '{v360}',                2001),
  ('reports.order_ageing',          'Reports', 'Ageing / stuck orders',       'Orders waiting too long in one status.',                          '{v360}',                2002),
  ('reports.turnaround',            'Reports', 'Turnaround times',            'Days spent in each stage, per brand.',                            '{v360}',                2003),
  ('reports.sku_sales',             'Reports', 'SKU / items report',          'Units per SKU: ordered, delivered, returned.',                    '{v360,brand}',          2004),
  ('reports.cancellations_holds',   'Reports', 'Cancellations & holds',       'Every cancellation and hold with its reason.',                     '{v360}',                2005),
  ('reports.status_history',        'Reports', 'Status history / audit',      'Every status change and override.',                               '{v360}',                2006),
  ('reports.brand_dispatches',      'Reports', 'Dispatches to the hub',       'Parcels sent to the hub and what arrived.',                       '{v360,brand}',          2007),
  ('reports.hub_receiving',         'Reports', 'Hub receiving',               'Orders received at the hub, items counted, weights.',             '{v360}',                2008),
  ('reports.hub_issues',            'Reports', 'Hub issues / short receipts', 'Items missing on arrival at the hub.',                            '{v360}',                2009),
  ('reports.shipment_register',     'Reports', 'Shipment register',           'Every shipment with carrier, tracking, weight and dates.',        '{v360}',                2010),
  ('reports.shipment_manifest',     'Reports', 'Shipment manifest',           'One shipment''s full contents.',                                  '{v360}',                2011),
  ('reports.transit_performance',   'Reports', 'Transit performance',         'Days in transit per carrier.',                                    '{v360}',                2012),
  ('reports.incoming_shipments',    'Reports', 'Incoming shipments',          'Shipments arriving and when they were received.',                 '{partner}',             2013),
  ('reports.confirmations',         'Reports', 'Confirmation report',         'Confirmation outcomes, attempts and time to confirm.',            '{v360,partner,brand}',  2014),
  ('reports.agent_productivity',    'Reports', 'Agent productivity',          'Confirmations and deliveries per staff member.',                  '{partner}',             2015),
  ('reports.bd_discrepancies',      'Reports', 'Receiving discrepancies',     'Items found short on receipt, and how they were resolved.',       '{v360,partner,brand}',  2016),
  ('reports.delivery_sheet',        'Reports', 'Delivery sheet',              'Orders out for delivery with address and cash to collect.',       '{partner}',             2017),
  ('reports.delivery_performance',  'Reports', 'Delivery performance',        'Delivered, failed and returned, by city and courier.',            '{v360,partner,brand}',  2018),
  ('reports.cod_collection',        'Reports', 'COD collection',              'Cash expected vs collected.',                                     '{v360,partner,brand}',  2019),
  ('reports.returns',               'Reports', 'Returns',                     'Returned orders and what happened to the goods.',                 '{v360,partner,brand}',  2020),
  ('reports.stock',                 'Reports', 'Stock report',                'Local stock levels, restocks and stock used for orders.',         '{v360,partner,brand}',  2021),
  ('reports.packing_list',          'Reports', 'Packing list',                'Confirmed orders to pack, item by item.',                         '{brand}',               2022),
  ('reports.invoice_register',      'Reports', 'Invoice register',            'All invoices with amounts and payment status.',                   '{v360}',                2023),
  ('reports.unpaid_ageing',         'Reports', 'Unpaid invoices ageing',      'Outstanding amounts by age.',                                     '{v360}',                2024),
  ('reports.brand_payables',        'Reports', 'Payables & statements',       'What is owed, statements issued and paid.',                       '{v360,brand}',          2025),
  ('reports.kbb_ledger',            'Reports', 'KBB account ledger',          'Advances, delivery payments, credits and balance.',               '{v360,partner}',        2026),
  ('reports.shipping_charges',      'Reports', 'Shipping charges',            'Freight charged per shipment.',                                   '{v360,brand}',          2027),
  ('reports.commissions',           'Reports', 'Commissions',                 'Commission per brand per month.',                                 '{v360}',                2028),
  ('reports.revenue',               'Reports', 'Revenue / GMV',               'Order value by brand, city and month.',                           '{v360}',                2029),
  ('reports.fx_history',            'Reports', 'FX rate history',             'Every exchange rate entered.',                                    '{v360}',                2030),
  ('reports.brand_scorecard',       'Reports', 'Brand directory & scorecard', 'Brand status, Shopify connection and performance.',               '{v360}',                2031),
  ('reports.shopify_sync',          'Reports', 'Shopify sync errors',         'Orders that failed to import, and replays.',                      '{v360}',                2032),
  ('reports.users_access',          'Reports', 'Users & access',              'Every user, their role and what each role can do.',               '{v360,partner,brand}',  2033)
on conflict (key) do nothing;   -- safe to re-run

-- ---------- Starter role defaults ------------------------------------------

do $$
declare r record;
begin
  for r in select ro.id, ro.name, ro.org_type from roles ro where ro.is_preset loop
    insert into role_permissions (role_id, permission)
    select r.id, p.key from permissions p
    where p.area = 'Reports' and r.org_type::text = any(p.applies_to)
      and case
        when r.org_type = 'v360' and r.name = 'Operator' then p.key <> 'reports.users_access'
        when r.org_type = 'v360' and r.name = 'Warehouse' then p.key in (
          'reports.brand_dispatches', 'reports.hub_receiving', 'reports.hub_issues',
          'reports.shipment_register', 'reports.shipment_manifest', 'reports.transit_performance')
        when r.org_type = 'partner' and r.name = 'KBB agent' then p.key <> 'reports.users_access'
        when r.org_type = 'partner' and r.name = 'Confirmation team' then p.key in ('reports.confirmations', 'reports.agent_productivity')
        when r.org_type = 'partner' and r.name = 'Delivery team' then p.key in (
          'reports.incoming_shipments', 'reports.bd_discrepancies', 'reports.delivery_sheet', 'reports.delivery_performance',
          'reports.cod_collection', 'reports.returns', 'reports.stock')
        when r.org_type = 'brand' and r.name = 'Staff' then p.key <> 'reports.users_access'
        when r.org_type = 'brand' and r.name = 'Customer service' then p.key in (
          'reports.order_register', 'reports.confirmations', 'reports.delivery_performance')
        when r.org_type = 'brand' and r.name = 'Warehouse manager' then p.key in (
          'reports.packing_list', 'reports.brand_dispatches', 'reports.bd_discrepancies', 'reports.stock')
        else false end
    on conflict do nothing;
  end loop;
end $$;

-- New brands get the same report defaults on their starter roles.
create or replace function _create_brand_presets(p_brand_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_staff uuid; v_id uuid;
begin
  insert into roles (org_type, organization_id, name, description, is_preset)
  values ('brand', p_brand_id, 'Staff', 'Everything except connecting Shopify.', true) returning id into v_staff;
  insert into role_permissions (role_id, permission)
  select v_staff, key from permissions
  where 'brand' = any(applies_to) and key not in ('shopify.manage', 'reports.users_access');

  insert into roles (org_type, organization_id, name, description, is_preset)
  values ('brand', p_brand_id, 'Customer service', 'Confirms orders and answers messages. No invoices or payments.', true) returning id into v_id;
  insert into role_permissions (role_id, permission)
  select v_id, unnest(array['orders.view', 'orders.confirm', 'orders.edit_customer', 'orders.messages',
                            'reports.order_register', 'reports.confirmations', 'reports.delivery_performance']);

  insert into roles (org_type, organization_id, name, description, is_preset)
  values ('brand', p_brand_id, 'Warehouse manager', 'Prepares orders and dispatches them to the hub. No invoices or payments.', true) returning id into v_id;
  insert into role_permissions (role_id, permission)
  select v_id, unnest(array['orders.view', 'orders.prepare', 'dispatch.view', 'dispatch.create', 'inventory.view', 'inventory.manage',
                            'reports.packing_list', 'reports.brand_dispatches', 'reports.bd_discrepancies', 'reports.stock']);

  return v_staff;
end $$;
revoke all on function _create_brand_presets(uuid) from public, anon, authenticated;

commit;
