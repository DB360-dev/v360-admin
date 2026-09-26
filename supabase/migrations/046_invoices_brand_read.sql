-- =====================================================================
-- 046_invoices_brand_read.sql
-- invoices was readable by every signed-in user (using (true)), so a
-- brand could read KBB's advance / settlement invoices and other brands'
-- payout invoices. The brand portal now lists the brand's own payout
-- invoices, so tighten reads:
--   * V360 and KBB staff: every invoice (unchanged; the staff "for all"
--     policy already covers them)
--   * brand members: only brand_payout invoices for their own brand
-- =====================================================================

drop policy if exists "Invoices are viewable by authenticated users" on invoices;

create policy invoices_read on invoices
  for select to authenticated
  using (
    is_v360() or is_partner()
    or (invoice_type = 'brand_payout' and brand_id is not null and is_brand_member(brand_id))
  );
