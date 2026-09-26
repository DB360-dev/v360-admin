-- =====================================================================
-- 042_order_internal_notes_brand.sql
-- Add a third role to order_internal_notes: 'brand'.
--
--   role = 'brand' -> visible/editable only by members of the order's brand
--
-- Admins and KBB never see brand notes, and brands never see admin or KBB
-- notes. order_overview.has_note is security_invoker, so brands now see
-- has_note = true when their own brand note exists.
-- =====================================================================

alter table order_internal_notes drop constraint if exists order_internal_notes_role_check;
alter table order_internal_notes
  add constraint order_internal_notes_role_check check (role in ('admin', 'kbb', 'brand'));

drop policy if exists internal_notes_read on order_internal_notes;
drop policy if exists internal_notes_write on order_internal_notes;

create policy internal_notes_read on order_internal_notes
  for select to authenticated
  using (
    (role = 'admin' and is_v360_admin())
    or (role = 'kbb' and is_partner())
    or (role = 'brand' and exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)))
  );

create policy internal_notes_write on order_internal_notes
  for all to authenticated
  using (
    (role = 'admin' and is_v360_admin())
    or (role = 'kbb' and is_partner())
    or (role = 'brand' and exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)))
  )
  with check (
    (role = 'admin' and is_v360_admin())
    or (role = 'kbb' and is_partner())
    or (role = 'brand' and exists (select 1 from orders o where o.id = order_id and is_brand_member(o.brand_id)))
  );
