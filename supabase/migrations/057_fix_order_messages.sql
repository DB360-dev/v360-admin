-- =====================================================================
-- 057_fix_order_messages.sql — put order messages back the way they were
--
-- 050_org_roles.sql permission-gated messaging and dropped the KBB read
-- path. Three things broke, all of them messaging and nothing else:
--
--   1. KBB could not SEND.
--      050:450-452 rewrote the guard in send_order_message from
--        if is_v360() or is_partner()
--      to
--        if v360_can('orders.messages') or partner_can('orders.messages')
--      partner_can() only passes if the member's role_id holds
--      orders.messages, and the two KBB roles 050 itself created
--      ("Confirmation team", "Delivery team") were built without it.
--      The RPC then raised 'You do not have access to this order' and
--      inserted nothing, so the message existed in no portal at all.
--      The ops portal hid the composer too (OrderMessages.tsx canSend),
--      so KBB saw no input box and no error.
--
--   2. KBB could not READ.
--      050:508-509 rewrote the msg_read policy but never gave it an
--      is_partner() branch, so every KBB thread query returned [] and
--      the ops notification bell stayed permanently empty.
--
--   3. Brands lost the thread.
--      The same rewrite swapped is_brand_member(o.brand_id) for
--      brand_can(o.brand_id, 'orders.messages'), and the "Warehouse
--      manager" preset (050:276-278) has no orders.messages. Any brand
--      user on that role lost the Notes section entirely.
--
-- Fix: restore exactly the two messaging objects to their 007 behaviour,
-- with the single addition that KBB can read. Nothing else is touched:
--
--   * roles / role_permissions / permissions  -- NOT modified
--   * every other table, policy and function   -- NOT modified
--   * order_messages rows                      -- NOT modified
--
-- Marking read is deliberately left alone: mark_messages_read was never
-- gated by 050 and already used is_v360() or is_partner(), so read, send
-- and mark-read are consistent again after this.
--
-- Ordering: this restores per-050 behaviour, so a later migration that
-- re-applies 050's gating (none is scheduled) would re-break it.
--
-- Rollback: supabase/rollbacks/057_revert_fix_order_messages.sql
-- =====================================================================

begin;

-- ---------- 1. Remember what is live right now --------------------------
-- Read-only snapshot so the rollback restores the exact 050 definitions
-- instead of re-typing them.

do $$
declare
  v_fn_src      text;
  v_fn_def      text;
  v_policy_qual text;
begin
  select p.prosrc, pg_get_functiondef(p.oid)
    into v_fn_src, v_fn_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'send_order_message'
    and pg_get_function_identity_arguments(p.oid) = 'p_order_id uuid, p_body text';

  -- pg_policies.qual is already deparsed text, which is exactly what the
  -- rollback feeds back into "create policy ... using (...)".
  select qual
    into v_policy_qual
  from pg_policies
  where tablename = 'order_messages' and policyname = 'msg_read';

  create table if not exists messaging_057_backup (
    id          int primary key default 1 check (id = 1),
    fn_src      text,
    fn_def      text,
    policy_qual text,
    saved_at    timestamptz not null default now()
  );

  -- on conflict do nothing on purpose: the snapshot must stay the state
  -- from the FIRST run of 057, i.e. the 050 definitions. Overwriting it on
  -- a second run would replace it with this migration's own output and
  -- quietly break 057_revert_fix_order_messages.sql.
  insert into messaging_057_backup (id, fn_src, fn_def, policy_qual)
  values (1, v_fn_src, v_fn_def, v_policy_qual)
  on conflict (id) do nothing;

  if exists (select 1 from messaging_057_backup where id = 1 and saved_at
             < now() - interval '1 second') then
    raise notice 'messaging_057_backup already exists; keeping the original snapshot';
  end if;

  raise notice 'backed up send_order_message: %',
    case when v_fn_def is null then 'MISSING' else 'ok' end;
  raise notice 'backed up msg_read: %',
    case when v_policy_qual is null then 'MISSING' else 'ok' end;
end $$;

-- ---------- 2. send_order_message: back to membership, not permissions ---

create or replace function send_order_message(p_order_id uuid, p_body text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_brand_id uuid;
  v_sender   text;
  v_type     text;
  v_msg_id   bigint;
begin
  select brand_id into v_brand_id from orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;

  -- Any V360 or KBB member may post; any brand member may reply.
  -- This is the 007 guard. Do not re-add v360_can/partner_can/brand_can
  -- here without also giving every KBB role orders.messages, or KBB goes
  -- silent again.
  if is_v360() or is_partner() then
    v_type   := 'admin';
    v_sender := current_actor_label();
  elsif is_brand_member(v_brand_id) then
    v_type   := 'brand';
    v_sender := current_actor_label();
  else
    raise exception 'You do not have access to this order';
  end if;

  if coalesce(trim(p_body), '') = '' then raise exception 'Message cannot be empty'; end if;

  insert into order_messages (order_id, sender_type, sender_label, body, read_by_brand, read_by_admin)
  values (
    p_order_id, v_type, v_sender, trim(p_body),
    (v_type = 'brand'),   -- brand's own message is already "read by brand"
    (v_type = 'admin')    -- admin's own message is already "read by admin"
  ) returning id into v_msg_id;

  return v_msg_id;
end $$;

grant execute on function send_order_message(uuid, text) to authenticated;

-- ---------- 3. msg_read: the 007 policy plus is_partner() ---------------
-- is_v360() or is_partner()  -> KBB reads every thread, as it could send
-- is_brand_member(...)       -> every brand member reads its own orders
-- brand_can is deliberately NOT used: it would put message access back
-- behind role_permissions, which is what caused this.

do $$
begin
  if exists (
    select 1 from pg_policies
    where tablename = 'order_messages' and policyname = 'msg_read'
  ) then
    drop policy msg_read on order_messages;
  else
    raise notice 'msg_read was missing on order_messages; recreating it';
  end if;
end $$;

create policy msg_read on order_messages for select to authenticated
  using (
    is_v360()
    or is_partner()
    or exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id))
  );

-- 007 granted authenticated SELECT here; 054 only took it from anon.
-- Re-asserting is a no-op if it survived, and unbreaks messages if not.
grant select on order_messages to authenticated;

commit;

-- ---------- 4. Realtime (outside the transaction) -----------------------
-- The ops and brand notification bells subscribe to INSERT on
-- order_messages. That table is published by the brand project's
-- 007_messaging.sql, which this repo does not own. Guarded so re-running
-- 057 is safe.

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'order_messages'
  ) then
    raise notice 'order_messages is already published; nothing to do';
    return;
  end if;

  if to_regclass('public.order_messages') is null then
    raise warning 'public.order_messages does not exist; is 007_messaging.sql applied? Skipping.';
    return;
  end if;

  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise warning 'supabase_realtime publication is missing. Create it in the dashboard, then re-run this block.';
    return;
  end if;

  execute 'alter publication supabase_realtime add table public.order_messages';
  raise notice 'added order_messages to supabase_realtime';
end $$;

-- ---------- 5. Verify (read-only) ---------------------------------------
-- Expect: RLS on order_messages = t, msg_read = t, realtime = t.

select
  (select relrowsecurity from pg_class where oid = 'public.order_messages'::regclass)        as rls_enabled,
  exists (select 1 from pg_policies
          where tablename = 'order_messages' and policyname = 'msg_read')                   as msg_read_exists,
  exists (select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and tablename = 'order_messages')             as realtime_published;