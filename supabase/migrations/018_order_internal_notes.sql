-- =====================================================================
-- 018_order_internal_notes.sql — Private notes on an order, V360 admins only.
-- These are "for keeping" notes and are never exposed to KBB partners,
-- V360 operators, or brands. RLS keeps access to is_v360_admin() only.
-- =====================================================================

create table if not exists order_internal_notes (
  order_id   uuid primary key references orders(id) on delete cascade,
  note       text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

alter table order_internal_notes enable row level security;

create policy internal_notes_admin_all on order_internal_notes
  for all to authenticated
  using (is_v360_admin())
  with check (is_v360_admin());

grant select, insert, update, delete on order_internal_notes to authenticated;