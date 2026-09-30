-- =====================================================================
-- ROLLBACK for migrations/058_remembered_product_weights.sql
--
-- Run by hand in the Supabase SQL editor only if 058 has to be undone.
-- Removes the remembered-weight functions and table. receive_order was
-- never changed by 058, so receiving itself needs no restoring — but the
-- ops portal must be rolled back to a build that calls receive_order
-- (not receive_order_weighed) first, or receiving will fail.
--
-- The remembered weights are deleted. Order weights already saved in
-- order_freight_weights are not touched.
-- =====================================================================

begin;

drop function if exists receive_order_weighed(uuid, numeric, jsonb, text, jsonb);
drop function if exists remembered_item_weights(uuid);
drop function if exists _product_weight_key(text);
drop table if exists product_weights;

commit;
