-- =====================================================================
-- 060_brand_cannot_confirm_for_partner.sql
--
-- Problem: a brand could mark an order "Fulfilment confirmed" (confirmed),
-- the status that means KBB reached the customer. The brand repo's
-- 014_brand_tracking_statuses.sql granted brand -> confirmed from every
-- pre-dispatch status, and the brand portal's "Confirmed" option used it
-- for anything that wasn't New. So after KBB marked an order "Customer
-- unreachable", the brand's "Confirmed" confirmed it in KBB's place.
--
-- Fix:
--   1. Brands can no longer move an order to `confirmed`, except back
--      from their own "Ready to ship" (brand_preparing -> confirmed is an
--      undo of marking ready; KBB had already confirmed that order).
--   2. brand_confirm_order also accepts confirmation_pending,
--      customer_unreachable and needs_amendment, moving the order back to
--      `brand_confirmed` so KBB calls the customer again.
--
-- KBB and V360 transitions are not touched. brand_confirm_order is
-- patched from its LIVE definition (one line); if that line isn't found
-- the migration aborts and nothing is changed.
--
-- Rollback: supabase/rollbacks/060_revert_brand_cannot_confirm_for_partner.sql
-- =====================================================================

begin;

create table fix060_backup (
  seq        serial primary key,
  kind       text not null,          -- 'function' | 'transition'
  definition text not null           -- function source, or the from_status of a removed row
);
alter table fix060_backup enable row level security;
revoke all on fix060_backup from anon, authenticated;

-- ---------- 1. Brands cannot set "Fulfilment confirmed" -------------------

insert into fix060_backup (kind, definition)
select 'transition', from_status::text from status_transitions
where actor = 'brand' and to_status = 'confirmed' and from_status <> 'brand_preparing';

delete from status_transitions
where actor = 'brand' and to_status = 'confirmed' and from_status <> 'brand_preparing';

-- ---------- 2. Brand re-confirm sends the order back to KBB ---------------

insert into fix060_backup (kind, definition)
select 'function', pg_get_functiondef(p.oid) from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'brand_confirm_order';

do $$
declare
  v_def text;
  v_new text;
begin
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'brand_confirm_order') <> 1 then
    raise exception '060: expected exactly one brand_confirm_order function';
  end if;
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'brand_confirm_order';

  v_new := regexp_replace(v_def, 'if\s+o\.status\s*<>\s*''new''\s+then',
    'if o.status not in (''new'', ''confirmation_pending'', ''customer_unreachable'', ''needs_amendment'') then', 'i');
  if v_new = v_def then
    raise exception '060: the line "if o.status <> ''new'' then" was not found in the live brand_confirm_order. Nothing was changed; send the live definition so it can be patched by hand.';
  end if;
  v_new := replace(v_new, 'only new orders can be confirmed by the brand',
                          'it can no longer be confirmed by the brand');
  execute v_new;
end $$;

commit;
