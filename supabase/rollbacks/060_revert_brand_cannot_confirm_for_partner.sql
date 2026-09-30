-- =====================================================================
-- ROLLBACK for migrations/060_brand_cannot_confirm_for_partner.sql
--
-- Run by hand in the Supabase SQL editor only if 060 has to be undone.
-- Gives brands back the ability to mark an order "Fulfilment confirmed"
-- and restores brand_confirm_order exactly as it was when 060 ran
-- (new orders only). Orders are not changed.
--
-- Roll the brand portal back as well, or its "Confirmed" option will fail
-- on orders that are not New.
-- =====================================================================

begin;

do $$
declare r record;
begin
  if to_regclass('public.fix060_backup') is null then
    raise exception 'fix060_backup not found: 060 was never applied or was already rolled back';
  end if;
  for r in select kind, definition from fix060_backup order by seq loop
    if r.kind = 'function' then
      execute r.definition;
    else
      insert into status_transitions (from_status, to_status, actor)
      values (r.definition::order_status, 'confirmed', 'brand')
      on conflict do nothing;
    end if;
  end loop;
end $$;

drop table fix060_backup;

commit;
