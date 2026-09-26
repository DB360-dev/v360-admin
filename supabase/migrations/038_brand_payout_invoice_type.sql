-- New invoice type for paying brands (own migration: a new enum value
-- can't be used in the transaction that adds it).
alter type invoice_type add value if not exists 'brand_payout';
