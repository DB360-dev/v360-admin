-- =====================================================================
-- 019_order_internal_notes_role_rls.sql
-- Convert order_internal_notes from a single admin-only note per order
-- to a ROLE-SCOPED note: one row per (order_id, role).
--
--   role = 'admin'  -> visible/editable only by V360 admins  (is_v360_admin)
--   role = 'kbb'    -> visible/editable only by KBB partners (is_partner)
--
-- Admins never see KBB notes, and KBB never sees admin notes.
-- Works whether or not 018 was already applied (it uses alter table +
-- drops/recreates the single policy).
-- =====================================================================

alter table order_internal_notes
  add column if not exists role text not null default 'admin'
    check (role in ('admin', 'kbb'));

-- One note per order per role instead of one per order.
do $$ begin
  if exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'order_internal_notes' and indexname = 'order_internal_notes_pkey') then
    alter table order_internal_notes drop constraint order_internal_notes_pkey;
  end if;
end $$;

alter table order_internal_notes
  add constraint order_internal_notes_pkey primary key (order_id, role);

-- Replace the single admin-only policy with role-scoped policies.
drop policy if exists internal_notes_admin_all on order_internal_notes;

create policy internal_notes_read on order_internal_notes
  for select to authenticated
  using (
    (role = 'admin' and is_v360_admin())
    or (role = 'kbb' and is_partner())
  );

create policy internal_notes_write on order_internal_notes
  for all to authenticated
  using (
    (role = 'admin' and is_v360_admin())
    or (role = 'kbb' and is_partner())
  )
  with check (
    (role = 'admin' and is_v360_admin())
    or (role = 'kbb' and is_partner())
  );

grant select, insert, update on order_internal_notes to authenticated;
