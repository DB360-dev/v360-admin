-- =====================================================================
-- 020_bd_receiving_override.sql
-- Adds p_override flag to bd_confirm_shipment_receiving so V360 admins
-- can complete receiving even when discrepancies have no notes.
-- Unchecked items still block everyone.
-- =====================================================================

create or replace function bd_confirm_shipment_receiving(
  p_shipment_id uuid,
  p_override    boolean default false
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_unchecked   int;
  v_undisclosed int;
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Not authorised';
  end if;

  if p_override and not is_v360() then
    raise exception 'Only V360 admins can override receiving discrepancies';
  end if;

  select count(*) into v_unchecked
  from orders o
  join order_items oi on oi.order_id = o.id
  where o.shipment_id = p_shipment_id
    and not exists (
      select 1 from bd_received_items r
      where r.shipment_id = p_shipment_id and r.order_item_id = oi.id
    );

  if v_unchecked > 0 then
    raise exception '% item(s) have not been checked yet', v_unchecked;
  end if;

  if not p_override then
    select count(*) into v_undisclosed
    from bd_received_items
    where shipment_id = p_shipment_id
      and received_qty <> expected_qty
      and (note is null or trim(note) = '');

    if v_undisclosed > 0 then
      raise exception '% discrepancy(s) need a note before confirming', v_undisclosed;
    end if;
  end if;

  perform set_shipment_status(p_shipment_id, 'received_by_partner',
    case when p_override then 'BD receiving completed with override by V360'
         else 'BD receiving check completed' end);
end $$;
