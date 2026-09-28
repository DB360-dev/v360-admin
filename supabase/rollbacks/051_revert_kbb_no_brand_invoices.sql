-- ROLLBACK for migrations/051_kbb_no_brand_invoices.sql (back to the 050 policies).
-- Run by hand in the Supabase SQL editor only if 051 has to be undone.

begin;

alter policy invoices_read on invoices
  using (
    v360_can('invoices.view') or partner_can('invoices.view')
    or (invoice_type = 'brand_payout' and brand_id is not null and brand_can(brand_id, 'invoices.view'))
  );

alter policy "Invoices are manageable by staff" on invoices
  using (v360_can('invoices.create') or partner_can('invoices.create'));

commit;
