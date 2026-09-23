-- =====================================================================
-- 007_shopify_app_secrets.sql — Shopify app Client ID + Secret, editable
-- from the Admin panel (V360 admins only).
--
-- Values live in Supabase Vault (like brand tokens). Edge Functions read
-- them via service role and fall back to SHOPIFY_API_KEY / SHOPIFY_API_SECRET
-- env secrets if the panel has never been used.
--
-- Browsers never see the stored values — only whether each is set.
-- =====================================================================

create table shopify_app_credentials (
  id                 boolean primary key default true check (id),
  api_key_secret_id  uuid,                 -- Vault secret: Shopify Client ID (SHOPIFY_API_KEY)
  api_secret_secret_id uuid,               -- Vault secret: Shopify Secret (SHOPIFY_API_SECRET)
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id) on delete set null
);

alter table shopify_app_credentials enable row level security;
-- No policies: only the security-definer functions below touch this table.
revoke all on shopify_app_credentials from anon, authenticated;

-- ---------- Save (partial updates allowed) --------------------------
-- Empty/NULL text means "keep the value already stored".

create function save_shopify_app_credentials(p_api_key text, p_api_secret text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_key_id    uuid;
  v_secret_id uuid;
begin
  if not is_v360_admin() then
    raise exception 'Only V360 admins can change Shopify credentials';
  end if;

  if p_api_key is not null and trim(p_api_key) = '' then p_api_key := null; end if;
  if p_api_secret is not null and trim(p_api_secret) = '' then p_api_secret := null; end if;

  select api_key_secret_id, api_secret_secret_id
    into v_key_id, v_secret_id
  from shopify_app_credentials
  where id
  for update;

  if p_api_key is null and p_api_secret is null then
    raise exception 'Enter the Shopify Client ID and/or Secret';
  end if;
  if p_api_key is null and v_key_id is null then
    raise exception 'Shopify Client ID is required';
  end if;
  if p_api_secret is null and v_secret_id is null then
    raise exception 'Shopify Secret is required';
  end if;

  if p_api_key is not null then
    if v_key_id is not null then
      perform vault.update_secret(v_key_id, p_api_key);
    else
      v_key_id := vault.create_secret(p_api_key, 'shopify_app_api_key', 'Shopify app Client ID (SHOPIFY_API_KEY)');
    end if;
  end if;

  if p_api_secret is not null then
    if v_secret_id is not null then
      perform vault.update_secret(v_secret_id, p_api_secret);
    else
      v_secret_id := vault.create_secret(p_api_secret, 'shopify_app_api_secret', 'Shopify app Secret (SHOPIFY_API_SECRET)');
    end if;
  end if;

  insert into shopify_app_credentials (id, api_key_secret_id, api_secret_secret_id, updated_at, updated_by)
  values (true, v_key_id, v_secret_id, now(), auth.uid())
  on conflict (id) do update set
    api_key_secret_id   = excluded.api_key_secret_id,
    api_secret_secret_id = excluded.api_secret_secret_id,
    updated_at          = now(),
    updated_by          = excluded.updated_by;
end $$;

-- ---------- Status for the UI (never returns the values) ------------

create function shopify_credentials_status()
returns table (client_id_set boolean, secret_set boolean, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_v360_admin() then
    raise exception 'Only V360 admins can view Shopify credentials';
  end if;
  return query
  select
    coalesce((select c.api_key_secret_id is not null from shopify_app_credentials c where c.id), false),
    coalesce((select c.api_secret_secret_id is not null from shopify_app_credentials c where c.id), false),
    (select c.updated_at from shopify_app_credentials c where c.id);
end $$;

-- ---------- Read decrypted values (Edge Functions / service role) ----

create function get_shopify_app_credentials()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'api_key', coalesce((
      select s.decrypted_secret from vault.decrypted_secrets s
      where s.id = c.api_key_secret_id
    ), ''),
    'api_secret', coalesce((
      select s.decrypted_secret from vault.decrypted_secrets s
      where s.id = c.api_secret_secret_id
    ), '')
  )
  from shopify_app_credentials c
  where c.id
$$;

-- ---------- Privileges -----------------------------------------------

revoke execute on function
  save_shopify_app_credentials(text, text),
  shopify_credentials_status(),
  get_shopify_app_credentials()
from public, anon;

grant execute on function
  save_shopify_app_credentials(text, text),
  shopify_credentials_status()
to authenticated;

revoke execute on function get_shopify_app_credentials() from authenticated;
grant execute on function get_shopify_app_credentials() to service_role;
