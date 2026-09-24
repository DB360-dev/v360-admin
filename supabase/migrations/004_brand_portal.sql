-- =====================================================================
-- 004_brand_portal.sql — What the Brand Portal needs on top of 001-003.
--   * Bulk "mark preparing"
--   * Fast status counts for tabs and the overview
--   * Inbound batch (dispatch) overview view
--   * Shopify OAuth: install state + token storage in Supabase Vault
--   * Hide the Vault secret id from browser clients
-- =====================================================================

-- ---------- Role of the current user in one organization ------------

create function my_role_in(p_org_id uuid) returns member_role
language sql stable security definer set search_path = public as $$
  select role from memberships where user_id = auth.uid() and organization_id = p_org_id
$$;

-- ---------- Bulk: mark confirmed orders as preparing -----------------

create function brand_mark_preparing(p_order_ids uuid[])
returns int
language plpgsql security definer set search_path = public as $$
declare
  o record;
  v_bad text;
  v_count int := 0;
begin
  if coalesce(array_length(p_order_ids, 1), 0) = 0 then raise exception 'Select at least one order'; end if;

  for o in select * from orders where id = any(p_order_ids) order by order_number for update loop
    if actor_group_for(o.brand_id) not in ('brand', 'v360') then
      raise exception 'You do not have access to order %', o.order_number;
    end if;
  end loop;

  select string_agg(order_number || ' ("' || status || '")', ', ') into v_bad
  from orders where id = any(p_order_ids) and status not in ('confirmed', 'brand_confirmed', 'brand_preparing');
  if v_bad is not null then
    raise exception 'Only confirmed orders can be marked as preparing. Not eligible: %', v_bad;
  end if;

  for o in select id from orders where id = any(p_order_ids) and status in ('confirmed', 'brand_confirmed') loop
    perform _set_order_status(o.id, 'brand_preparing', 'Marked as preparing');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------- Status counts (RLS applies: security invoker) -----------

create function brand_order_counts(p_brand_id uuid)
returns table (status order_status, count bigint)
language sql stable security invoker set search_path = public as $$
  select o.status, count(*) from orders o where o.brand_id = p_brand_id group by o.status
$$;

-- ---------- Dispatch overview ----------------------------------------

create view inbound_batch_overview with (security_invoker = true) as
select
  b.id, b.brand_id, b.courier, b.tracking_number, b.dispatch_date, b.status, b.courier_status,
  b.notes, b.created_at, b.received_at,
  count(o.id)                                                          as order_count,
  count(o.id) filter (where o.status = 'dispatched_to_hub')            as awaiting_count,
  count(o.id) filter (where o.status = 'hub_issue')                    as issue_count,
  count(o.id) filter (where o.status not in ('dispatched_to_hub', 'hub_issue')) as received_count
from inbound_batches b
left join orders o on o.inbound_batch_id = b.id
group by b.id;

-- ---------- Shopify OAuth --------------------------------------------

create table shopify_oauth_states (
  state        text primary key,
  brand_id     uuid not null references organizations(id) on delete cascade,
  shop_domain  text not null,
  user_id      uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '15 minutes'
);
alter table shopify_oauth_states enable row level security;  -- no policies: service role only

-- Store (or rotate) a brand's Shopify token in Vault. Service role only.
create function save_shopify_connection(p_brand_id uuid, p_shop_domain text, p_access_token text, p_scopes text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_existing shopify_connections%rowtype;
  v_secret uuid;
begin
  if exists (select 1 from shopify_connections where shop_domain = p_shop_domain and brand_id <> p_brand_id) then
    raise exception 'This Shopify store is already connected to another brand';
  end if;

  select * into v_existing from shopify_connections where brand_id = p_brand_id for update;

  if found and v_existing.token_secret_id is not null then
    perform vault.update_secret(v_existing.token_secret_id, p_access_token);
    v_secret := v_existing.token_secret_id;
  else
    v_secret := vault.create_secret(p_access_token,
                  'shopify_' || p_brand_id || '_' || extract(epoch from now())::bigint,
                  'Shopify Admin API token for ' || p_shop_domain);
  end if;

  insert into shopify_connections (brand_id, shop_domain, token_secret_id, scopes, status, installed_at)
  values (p_brand_id, p_shop_domain, v_secret, p_scopes, 'active', now())
  on conflict (brand_id) do update set
    shop_domain = excluded.shop_domain, token_secret_id = excluded.token_secret_id,
    scopes = excluded.scopes, status = 'active', installed_at = now();

  return v_secret;
end $$;

-- Read a brand's token (for future Shopify API calls). Service role only.
create function get_shopify_token(p_brand_id uuid)
returns text
language sql stable security definer set search_path = public as $$
  select s.decrypted_secret
  from shopify_connections c join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.brand_id = p_brand_id and c.status = 'active'
$$;

-- ---------- Privileges -----------------------------------------------
-- Supabase grants new tables/functions to anon + authenticated by
-- default, so lock down explicitly.

revoke all on shopify_oauth_states from anon, authenticated;

revoke execute on function
  my_role_in(uuid), brand_mark_preparing(uuid[]), brand_order_counts(uuid),
  save_shopify_connection(uuid, text, text, text), get_shopify_token(uuid)
from public, anon, authenticated;

grant execute on function my_role_in(uuid), brand_mark_preparing(uuid[]), brand_order_counts(uuid)
  to authenticated;
grant execute on function save_shopify_connection(uuid, text, text, text), get_shopify_token(uuid)
  to service_role;
grant all on shopify_oauth_states to service_role;

revoke all on inbound_batch_overview from anon;
grant select on inbound_batch_overview to authenticated;

-- Browsers may read connection status but never the Vault secret id.
-- (Frontend must select these columns explicitly, not "*".)
revoke select on shopify_connections from authenticated;
grant select (id, brand_id, shop_domain, scopes, status, last_synced_at, installed_at, created_at)
  on shopify_connections to authenticated;

-- ---------- Realtime -------------------------------------------------

alter publication supabase_realtime add table inbound_batches;
