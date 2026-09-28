-- =====================================================================
-- 051_kbb_no_brand_invoices.sql
-- Brand payout invoices are between V360 and a brand. KBB staff (admins
-- included) could still read them because they live in the same
-- `invoices` table as KBB's own dispatch / settlement invoices.
-- KBB now only sees non-payout invoices. Brand shipping charges
-- (brand_shipping_invoices) were already V360 + brand only.
--
-- Rollback: supabase/rollbacks/051_revert_kbb_no_brand_invoices.sql
-- =====================================================================

begin;

alter policy invoices_read on invoices
  using (
    v360_can('invoices.view')
    or (partner_can('invoices.view') and invoice_type <> 'brand_payout')
    or (invoice_type = 'brand_payout' and brand_id is not null and brand_can(brand_id, 'invoices.view'))
  );

-- FOR ALL policy (also grants reads): same rule for KBB.
alter policy "Invoices are manageable by staff" on invoices
  using (v360_can('invoices.create') or (partner_can('invoices.create') and invoice_type <> 'brand_payout'));

commit;
