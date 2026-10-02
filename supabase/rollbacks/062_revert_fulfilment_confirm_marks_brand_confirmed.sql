-- Reverts 062: removes the trigger and clears brand_confirmed_at on the
-- orders 062 backfilled (only those still unconfirmed by a brand user).
begin;

drop trigger if exists orders_fulfilment_confirm_marks_brand on orders;
drop function if exists orders_fulfilment_confirm_marks_brand();

update orders o
set brand_confirmed_at = null
from fix062_backfilled b
where o.id = b.order_id and o.brand_confirmed_by is null;

drop table if exists fix062_backfilled;

commit;
