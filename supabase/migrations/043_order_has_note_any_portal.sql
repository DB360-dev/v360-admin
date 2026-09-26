-- =====================================================================
-- 043_order_has_note_any_portal.sql
-- order_overview.has_note now means "someone, in any portal, has left a
-- note on this order", so the notes icon shows the same in the admin, KBB
-- and brand portals.
--
-- A note is either:
--   * a non-empty order_internal_notes row of any role (admin, kbb, brand)
--   * an order_messages row (the brand <-> team "Notes" thread)
--
-- The view is security_invoker, so the old EXISTS only saw notes the caller
-- could read. order_has_note is security definer: it reveals only a yes/no
-- flag, never the note text, and only for orders the caller can access.
-- =====================================================================

create or replace function order_has_note(p_order_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from orders o
    where o.id = p_order_id
      and (is_v360() or is_partner() or is_brand_member(o.brand_id))
      and (
        exists (select 1 from order_internal_notes n where n.order_id = o.id and trim(n.note) <> '')
        or exists (select 1 from order_messages m where m.order_id = o.id)
      )
  )
$$;

revoke all on function order_has_note(uuid) from public, anon;
grant execute on function order_has_note(uuid) to authenticated;

-- The live view differs from the repo, so swap only the has_note expression
-- in its current definition instead of replacing the whole view.
do $$
declare
  v_def text := pg_get_viewdef('order_overview'::regclass, true);
  v_new text;
begin
  if v_def ~ 'order_has_note\(' then return; end if;

  if v_def ~ 'AS has_note' then
    v_new := regexp_replace(
      v_def,
      '\(?EXISTS \( SELECT 1\s+FROM order_internal_notes.*?\)+ AS has_note',
      'order_has_note(o.id) AS has_note'
    );
    if v_new = v_def then
      raise exception 'order_overview: could not find the has_note expression. Definition: %', v_def;
    end if;
  else
    v_new := regexp_replace(v_def, E'\n   FROM ', E',\n    order_has_note(o.id) AS has_note\n   FROM ');
  end if;

  execute 'create or replace view order_overview with (security_invoker = true) as ' || v_new;
end $$;
