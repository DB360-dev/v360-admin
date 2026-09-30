-- =====================================================================
-- ROLLBACK for migrations/057_fix_order_messages.sql
--
-- Run by hand in the Supabase SQL editor only if 057 has to be undone.
-- Puts the permission-gated messaging from 050 back in place, restoring
-- the exact definitions captured in messaging_057_backup at the moment 057
-- ran. If that table is empty (057 was never applied, or the backup was
-- dropped) this script changes nothing.
--
-- Undoing 057 brings back the original 050 behaviour, so KBB users on
-- "Confirmation team" / "Delivery team" lose messaging again.
--
-- Messages already sent stay in order_messages; nothing is deleted here.
-- =====================================================================

begin;

do $$
declare
  v_fn_def      text;
  v_policy_qual text;
begin
  select fn_def, policy_qual into v_fn_def, v_policy_qual
  from messaging_057_backup where id = 1;

  if v_fn_def is null and v_policy_qual is null then
    raise warning 'messaging_057_backup has nothing saved; leaving messaging as 057 left it.';
    return;
  end if;

  -- 1. send_order_message back to its 050 body.
  if v_fn_def is not null then
    execute v_fn_def;
    grant execute on function send_order_message(uuid, text) to authenticated;
    raise notice 'restored send_order_message from backup';
  else
    raise warning 'no send_order_message in the backup; leaving it as 057 left it';
  end if;

  -- 2. msg_read back to its 050 qual.
  if v_policy_qual is not null then
    drop policy if exists msg_read on order_messages;
    execute format(
      'create policy msg_read on order_messages for select to authenticated using (%s)',
      v_policy_qual);
    raise notice 'restored msg_read from backup';
  else
    raise warning 'no msg_read in the backup; leaving it as 057 left it';
  end if;
end $$;

commit;

-- The backup has served its purpose; keep it only if you may need to
-- re-run this rollback. It holds function text, nothing personal.
-- drop table if exists messaging_057_backup;