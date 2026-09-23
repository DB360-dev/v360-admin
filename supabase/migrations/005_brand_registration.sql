-- =====================================================================
-- 005_brand_registration.sql — Brands can sign up themselves.
--
-- Sign-up creates: the user's profile, a new brand organization, and a
-- brand_owner membership. The brand starts PENDING (is_active = false),
-- so it can't see or do anything until V360 approves it.
--
-- IMPORTANT: in Supabase, Authentication -> Sign In / Providers,
-- "Allow new users to sign up" must be ON for registration to work.
-- =====================================================================

create type approval_status as enum ('pending', 'approved', 'rejected');

alter table organizations
  add column approval_status approval_status not null default 'approved',
  add column contact_phone   text,
  add column registered_by   uuid references auth.users(id) on delete set null,
  add column reviewed_at     timestamptz,
  add column review_note     text;

-- ---------- Sign-up hook ---------------------------------------------
-- Brand registration is recognised by user metadata sent from the
-- register screen: { signup_type: "brand", brand_name, full_name, phone }.
-- Users invited by V360 don't carry signup_type, so no brand is created.

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_brand_name text := left(trim(coalesce(meta->>'brand_name', '')), 120);
  v_org uuid;
begin
  insert into profiles (id, email, full_name, phone)
  values (new.id, new.email,
          nullif(left(trim(coalesce(meta->>'full_name', '')), 120), ''),
          nullif(left(trim(coalesce(meta->>'phone', '')), 40), ''))
  on conflict (id) do nothing;

  if meta->>'signup_type' = 'brand' and v_brand_name <> '' then
    insert into organizations (name, type, is_active, approval_status, contact_phone, registered_by)
    values (v_brand_name, 'brand', false, 'pending',
            nullif(left(trim(coalesce(meta->>'phone', '')), 40), ''), new.id)
    returning id into v_org;

    insert into memberships (user_id, organization_id, role)
    values (new.id, v_org, 'brand_owner');
  end if;

  return new;
end $$;

-- 003 created the trigger only if auth.users had raw_user_meta_data
-- (always true on Supabase). Make sure it exists.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'auth' and table_name = 'users' and column_name = 'raw_user_meta_data')
     and not exists (select 1 from pg_trigger where tgname = 'on_auth_user_created') then
    create trigger on_auth_user_created after insert on auth.users
      for each row execute function handle_new_user();
  end if;
end $$;

-- ---------- V360 reviews registrations ------------------------------

create function approve_brand(p_org_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_v360_admin() then raise exception 'Only V360 admins can approve brands'; end if;
  update organizations set is_active = true, approval_status = 'approved',
         reviewed_at = now(), review_note = p_note
  where id = p_org_id and type = 'brand';
  if not found then raise exception 'Brand not found'; end if;
end $$;

create function reject_brand(p_org_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_v360_admin() then raise exception 'Only V360 admins can reject brands'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'A reason is required'; end if;
  update organizations set is_active = false, approval_status = 'rejected',
         reviewed_at = now(), review_note = p_note
  where id = p_org_id and type = 'brand';
  if not found then raise exception 'Brand not found'; end if;
end $$;

-- ---------- Privileges -----------------------------------------------

revoke execute on function handle_new_user() from public, anon, authenticated;
revoke execute on function approve_brand(uuid, text), reject_brand(uuid, text) from public, anon, authenticated;
grant execute on function approve_brand(uuid, text), reject_brand(uuid, text) to authenticated;

-- Brands must not be able to approve themselves by editing their own row.
-- (org_write already limits writes to V360 admins; this is a second lock.)
create function guard_org_approval() returns trigger language plpgsql as $$
begin
  if (new.is_active is distinct from old.is_active or new.approval_status is distinct from old.approval_status)
     and auth.uid() is not null and not is_v360_admin() then
    raise exception 'Only V360 admins can change a brand''s approval';
  end if;
  return new;
end $$;

create trigger organizations_guard_approval before update on organizations
  for each row execute function guard_org_approval();
