-- =====================================================================
-- 037_shopify_payment_sync.sql
-- Records what the shopify-payment-sync Edge Function pushed to Shopify
-- for each order when its invoices are marked paid:
--   50% dispatch advance invoice paid  -> Shopify "Partially paid"
--   final settlement invoice paid      -> Shopify "Paid"
-- =====================================================================

alter table orders
  add column if not exists shopify_payment_synced    text
    check (shopify_payment_synced in ('partially_paid', 'paid')),
  add column if not exists shopify_payment_synced_at timestamptz,
  add column if not exists shopify_payment_error     text;
