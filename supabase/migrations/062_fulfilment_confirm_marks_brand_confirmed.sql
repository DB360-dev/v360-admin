-- =====================================================================
-- 062_fulfilment_confirm_marks_brand_confirmed.sql
--
-- Problem: KBB can confirm an order (status `confirmed`) straight from New,
-- before the brand ever confirmed it. The order then reads "Not confirmed
-- by brand" on the brand side even though fulfilment has confirmed it.
--
-- Fix: when an order moves to `confirmed` and the brand has not confirmed
-- it, stamp brand_confirmed_at so the brand status becomes "Brand confirmed"
-- and the order shows as confirmed. If the brand already confirmed, its
-- original brand_confirmed_at / brand_confirmed_by are kept as they are.
-- brand_confirmed_by stays null on these rows (no brand user confirmed).
--
-- Also backfills orders currently `confirmed` with no brand confirmation.
--
-- Rollback: supabase/rollbacks/062_revert_fulfilment_confirm_marks_brand_confirmed.sql
-- =====================================================================

begin;

create table if not exists fix062_backfilled (order_id uuid primary key);
alter table fix062_backfilled enable row level security;
revoke all on fix062_backfilled from anon, authenticated;

create or replace function orders_fulfilment_confirm_marks_brand()
returns trigger
language plpgsql set search_path = public as $$
begin
  new.brand_confirmed_at := now();
  return new;
end $$;

drop trigger if exists orders_fulfilment_confirm_marks_brand on orders;
create trigger orders_fulfilment_confirm_marks_brand
  before update of status on orders
  for each row
  when (new.status = 'confirmed' and new.brand_confirmed_at is null)
  execute function orders_fulfilment_confirm_marks_brand();

-- Backfill: orders already confirmed by fulfilment but never by the brand.
with fixed as (
  update orders
  set brand_confirmed_at = coalesce(confirmed_at, status_changed_at, now())
  where status = 'confirmed' and brand_confirmed_at is null
  returning id
)
insert into fix062_backfilled (order_id) select id from fixed;

commit;
