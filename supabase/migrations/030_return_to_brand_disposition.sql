-- New return decision for goods that never left Pakistan (order cancelled
-- before its shipment was handed to the carrier): send them back to the brand.
-- Kept in its own migration: a new enum value can't be used in the same
-- transaction that adds it.
alter type return_disposition add value if not exists 'return_to_brand';
