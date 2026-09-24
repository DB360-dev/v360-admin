-- =====================================================================
-- 016_update_invoice_payment.sql — Function to update invoice payment status
-- =====================================================================

create or replace function set_invoice_payment_status(
  p_invoice_number text,
  p_status invoice_payment_status
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_shipment_ids uuid[];
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Only authorized staff can change invoice payment status';
  end if;

  -- 1. Update invoices table if record exists
  update invoices set
    payment_status = p_status,
    updated_at = now()
  where invoice_number = p_invoice_number
  returning shipment_ids into v_shipment_ids;

  -- 2. Update shipments if shipment_ids exist
  if v_shipment_ids is not null and array_length(v_shipment_ids, 1) > 0 then
    update shipments set
      invoice_payment_status = p_status
    where id = any(v_shipment_ids);
  end if;

  -- 3. If invoice_number matches INV-DISP-{code} or INV-SETTLE-{code} or INV-KBB-{code}
  update shipments set
    invoice_payment_status = p_status
  where code = replace(replace(replace(p_invoice_number, 'INV-DISP-', ''), 'INV-SETTLE-', ''), 'INV-KBB-', '');
end $$;

grant execute on function set_invoice_payment_status(text, invoice_payment_status) to authenticated;
