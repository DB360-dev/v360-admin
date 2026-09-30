-- =====================================================================
-- 059_test_brands.sql — test brands whose orders KBB never sees
--
-- An admin can mark a brand as a TEST brand (Brands page). Everything that
-- belongs to a test brand is then invisible to KBB (partner) users, so test
-- orders never reach their Confirmations queue, shipments, deliveries,
-- reports or account. V360 and the test brand itself see them as usual,
-- and V360 staff do KBB's steps themselves (they already may, by
-- permission: confirm, receive in Bangladesh, track, deliver).
--
-- How it hides
--   RESTRICTIVE row-level policies, added NEXT TO the existing policies.
--   No existing policy is changed, so nothing else about access moves;
--   for everyone who is not a KBB-only user the new policies are always
--   true. Views are security_invoker, so they follow automatically.
--
-- Shipments
--   A test order may only share a shipment with other test orders (a KBB
--   user confirming a mixed shipment would trip over orders they can't
--   see). Test-only shipments are hidden from KBB too.
--
-- Money
--   kbb_account_overview and brand_payable_overview are security definer
--   (they bypass the policies), so each gets one extra filter. They are
--   patched in place from the LIVE definition; if the expected line isn't
--   found the whole migration aborts and nothing is changed.
--   Live definitions are saved in test059_backup for the rollback.
--
-- Not changed: V360's own lists, dashboards and reports still include test
-- orders (the brand name tells them apart).
--
-- Rollback: supabase/rollbacks/059_revert_test_brands.sql
-- =====================================================================

begin;

-- ---------- 1. The switch ------------------------------------------------

alter table organizations add column if not exists is_test boolean not null default false;

create table test059_backup (
  seq        serial primary key,
  name       text not null,
  definition text not null
);
alter table test059_backup enable row level security;
revoke all on test059_backup from anon, authenticated;

-- ---------- 2. Helpers ---------------------------------------------------
-- "Partner only": a KBB user who is not also V360 staff.

create or replace function _hides_test_data() returns boolean
language sql stable security definer set search_path = public as $$
  select is_partner() and not is_v360()
$$;

create or replace function _is_test_brand(p_brand_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_test from organizations where id = p_brand_id), false)
$$;

-- Shipments carrying test orders (they never carry anything else, see 4).
create or replace function _test_shipment_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct o.shipment_id), '{}'::uuid[])
  from orders o join organizations b on b.id = o.brand_id
  where b.is_test and o.shipment_id is not null
$$;

-- What the CALLER must not see: empty for everyone except KBB-only users.
create or replace function _hidden_brand_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when _hides_test_data()
    then coalesce((select array_agg(id) from organizations where is_test), '{}'::uuid[])
    else '{}'::uuid[] end
$$;

create or replace function _hidden_order_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when _hides_test_data()
    then coalesce((select array_agg(o.id) from orders o join organizations b on b.id = o.brand_id where b.is_test), '{}'::uuid[])
    else '{}'::uuid[] end
$$;

create or replace function _hidden_shipment_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when _hides_test_data() then _test_shipment_ids() else '{}'::uuid[] end
$$;

revoke all on function _hides_test_data(), _is_test_brand(uuid), _test_shipment_ids(),
  _hidden_brand_ids(), _hidden_order_ids(), _hidden_shipment_ids() from public, anon, authenticated;
-- The policies below call these as the signed-in user.
grant execute on function _hidden_brand_ids(), _hidden_order_ids(), _hidden_shipment_ids() to authenticated;

-- ---------- 3. Hide test data from KBB -----------------------------------

do $$
declare
  r record;
  v_fn text;
  v_policy text;
begin
  for r in select * from (values
    ('organizations',          'id',          'brand'),
    ('orders',                 'brand_id',    'brand'),
    ('inbound_batches',        'brand_id',    'brand'),
    ('shipment_brand_weights', 'brand_id',    'brand'),
    ('courier_brand_stores',   'brand_id',    'brand'),
    ('shopify_connections',    'brand_id',    'brand'),
    ('brand_money_settings',   'brand_id',    'brand'),
    ('invoices',               'brand_id',    'brand'),
    ('order_items',            'order_id',    'order'),
    ('order_events',           'order_id',    'order'),
    ('order_messages',         'order_id',    'order'),
    ('order_internal_notes',   'order_id',    'order'),
    ('order_freight_weights',  'order_id',    'order'),
    ('bd_received_items',      'order_id',    'order'),
    ('courier_parcels',        'order_id',    'order'),
    ('kbb_payments',           'order_id',    'order'),
    ('kbb_payments',           'shipment_id', 'shipment'),
    ('shipments',              'id',          'shipment'),
    ('shipment_events',        'shipment_id', 'shipment')
  ) t(tbl, col, kind) loop
    if not exists (select 1 from information_schema.columns c
                   where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col) then
      raise notice '059: %.% not found, skipped', r.tbl, r.col;
      continue;
    end if;
    v_fn := '_hidden_' || r.kind || '_ids';
    v_policy := 'hide_test_' || r.col;
    execute format('drop policy if exists %I on %I', v_policy, r.tbl);
    execute format(
      'create policy %I on %I as restrictive for all to authenticated
         using (not coalesce(%I = any ((select %I())::uuid[]), false))',
      v_policy, r.tbl, r.col, v_fn);
  end loop;

  -- KBB invoices list shipments / orders in arrays.
  if exists (select 1 from information_schema.columns c
             where c.table_schema = 'public' and c.table_name = 'invoices' and c.column_name = 'shipment_ids')
     and exists (select 1 from information_schema.columns c
             where c.table_schema = 'public' and c.table_name = 'invoices' and c.column_name = 'order_ids') then
    drop policy if exists hide_test_lists on invoices;
    create policy hide_test_lists on invoices as restrictive for all to authenticated
      using (not coalesce(shipment_ids && (select _hidden_shipment_ids())::uuid[], false)
         and not coalesce(order_ids    && (select _hidden_order_ids())::uuid[],    false));
  end if;
end $$;

-- ---------- 4. Test and real orders never share a shipment ---------------

create or replace function _guard_test_shipment_mix() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_test boolean := _is_test_brand(new.brand_id);
begin
  if exists (select 1 from orders o join organizations b on b.id = o.brand_id
             where o.shipment_id = new.shipment_id and o.id <> new.id and b.is_test <> v_test) then
    raise exception 'Test-brand orders can''t share a shipment with real orders. Put them in a shipment of their own.';
  end if;
  return null;
end $$;

drop trigger if exists orders_guard_test_shipment_mix on orders;
create trigger orders_guard_test_shipment_mix
  after insert or update of shipment_id on orders
  for each row when (new.shipment_id is not null)
  execute function _guard_test_shipment_mix();

-- ---------- 5. Switching a brand to / from test --------------------------
-- Second lock, like guard_org_approval: only V360 staff with brand
-- settings may flip the flag, and never into a mixed shipment.

create or replace function _guard_org_is_test() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_test is not distinct from old.is_test then return new; end if;

  if auth.uid() is not null and not coalesce(v360_can('brands.settings'), false) then
    raise exception 'Only V360 staff who can edit brand settings can mark a test brand';
  end if;
  if new.is_test and new.type <> 'brand' then
    raise exception 'Only a brand can be a test brand';
  end if;
  if exists (
    select 1 from orders mine
    join orders other on other.shipment_id = mine.shipment_id and other.brand_id <> mine.brand_id
    join organizations b on b.id = other.brand_id
    where mine.brand_id = new.id and mine.shipment_id is not null and b.is_test <> new.is_test
  ) then
    raise exception '% has orders in a shipment shared with other brands. Remove them from that shipment (or wait until it is finished and use a new brand) before changing this.', new.name;
  end if;
  return new;
end $$;

drop trigger if exists organizations_guard_is_test on organizations;
create trigger organizations_guard_is_test before update of is_test on organizations
  for each row execute function _guard_org_is_test();

create or replace function set_brand_test(p_brand_id uuid, p_is_test boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(v360_can('brands.settings'), false) then
    raise exception 'You do not have permission to change brand settings';
  end if;
  if p_is_test is null then raise exception 'Choose test or live'; end if;

  update organizations set is_test = p_is_test where id = p_brand_id and type = 'brand';
  if not found then raise exception 'Brand not found'; end if;
end $$;

revoke all on function _guard_test_shipment_mix(), _guard_org_is_test() from public, anon, authenticated;
revoke all on function set_brand_test(uuid, boolean) from public, anon;
grant execute on function set_brand_test(uuid, boolean) to authenticated;

-- ---------- 6. Keep test orders out of the money ledgers -----------------
-- Patch the live definitions: one extra filter each, nothing else.

insert into test059_backup (name, definition)
select p.proname, pg_get_functiondef(p.oid) from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('kbb_account_overview', 'brand_payable_overview');

do $$
declare
  r record;
  v_fn  text;
  v_def text;
  v_new text;
begin
  for r in select * from (values
    -- KBB account: test orders add nothing to what KBB owes ...
    ('kbb_account_overview', 'where\s+o\.shipment_id\s*=\s*s\.id',
       'where o.shipment_id = s.id and not _is_test_brand(o.brand_id)'),
    -- ... and test-only shipments are not listed at all.
    ('kbb_account_overview', 'where\s+s\.status\s*>=\s*''handed_to_carrier''',
       'where s.status >= ''handed_to_carrier'' and not (s.id = any (_test_shipment_ids()))'),
    -- Payable to brands: a test brand is never owed anything.
    ('brand_payable_overview', 'and\s+o\.status\s*=\s*''delivered''',
       'and o.status = ''delivered'' and not b.is_test')
  ) t(fn, pattern, replacement) loop
    select p.oid::regprocedure::text, pg_get_functiondef(p.oid) into v_fn, v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fn;
    if not found then raise exception '059: function % not found', r.fn; end if;
    if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fn) > 1 then
      raise exception '059: more than one function named %; patch it by hand', r.fn;
    end if;

    v_new := regexp_replace(v_def, r.pattern, r.replacement, 'i');   -- first match only
    if v_new = v_def then
      raise exception '059: the expected line was not found in the live % (pattern: %). Nothing was changed; send the live definition so the filter can be placed by hand.', r.fn, r.pattern;
    end if;
    execute v_new;
  end loop;
end $$;

commit;
