-- =====================================================================
-- 017_order_payment_status.sql — Order payment status tracking & view updates
-- =====================================================================

-- 1. Add invoice_payment_status column to orders table
ALTER TABLE orders 
  ADD COLUMN IF NOT EXISTS invoice_payment_status invoice_payment_status NOT NULL DEFAULT 'not_paid';

-- 2. Backfill existing orders payment status
-- Set partially_paid for orders in shipments with paid advance invoice
UPDATE orders o
SET invoice_payment_status = 'partially_paid'
FROM shipments s
WHERE o.shipment_id = s.id
  AND s.invoice_payment_status = 'paid'
  AND o.invoice_payment_status = 'not_paid';

-- Set paid for orders in paid final_settlement invoices
UPDATE orders o
SET invoice_payment_status = 'paid'
FROM invoices i
WHERE i.invoice_type = 'final_settlement'
  AND i.payment_status = 'paid'
  AND (o.id = ANY(i.order_ids) OR o.shipment_id = ANY(i.shipment_ids));

-- 3. Recreate order_overview view to include invoice_payment_status
DROP VIEW IF EXISTS order_overview CASCADE;

CREATE VIEW order_overview WITH (security_invoker = true) AS
SELECT
  o.id, o.order_number, o.shopify_order_id, o.order_date, o.status, o.status_changed_at,
  o.brand_id, b.name as brand_name,
  o.customer_name, o.customer_phone, o.city, o.country_code,
  o.order_total, o.currency, o.cod_amount_expected, o.cod_amount_collected, o.cod_currency,
  o.confirmation_attempts,
  o.inbound_batch_id, ib.courier as inbound_courier, ib.tracking_number as inbound_tracking,
  o.shipment_id, s.code as shipment_code, s.tracking_number as shipment_tracking,
  s.shipping_partner, s.status as shipment_status, s.invoice_payment_status as shipment_invoice_payment_status,
  o.invoice_payment_status,
  o.is_settled, o.settled_at,
  o.delivery_courier, o.delivery_tracking_number, o.delivered_at,
  (SELECT coalesce(sum(quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS item_count,
  (SELECT string_agg(distinct i.sku, ', ') FROM order_items i WHERE i.order_id = o.id AND i.sku IS NOT NULL) AS skus,
  now() - o.status_changed_at AS time_in_status
FROM orders o
JOIN organizations b ON b.id = o.brand_id
LEFT JOIN inbound_batches ib ON ib.id = o.inbound_batch_id
LEFT JOIN shipments s ON s.id = o.shipment_id;

GRANT SELECT ON order_overview TO authenticated;

-- 4. Drop existing function signatures to avoid 42P13 return type mismatch error
DROP FUNCTION IF EXISTS set_invoice_payment_status(text, invoice_payment_status);
DROP FUNCTION IF EXISTS set_invoice_payment_status(text, text);

-- 5. Update set_invoice_payment_status to update order payment statuses
CREATE OR REPLACE FUNCTION set_invoice_payment_status(
  p_invoice_number text,
  p_status invoice_payment_status
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shipment_ids uuid[];
  v_order_ids uuid[];
  v_invoice_type invoice_type;
BEGIN
  IF NOT (is_v360() OR is_partner()) THEN
    RAISE EXCEPTION 'Only authorized staff can change invoice payment status';
  END IF;

  -- Update invoices table if record exists
  UPDATE invoices SET
    payment_status = p_status,
    updated_at = now()
  WHERE invoice_number = p_invoice_number
  RETURNING shipment_ids, order_ids, invoice_type INTO v_shipment_ids, v_order_ids, v_invoice_type;

  -- Dispatch advance invoice handling
  IF v_invoice_type = 'dispatch_advance' OR p_invoice_number LIKE 'INV-DISP-%' THEN
    IF v_shipment_ids IS NOT NULL AND array_length(v_shipment_ids, 1) > 0 THEN
      UPDATE shipments SET invoice_payment_status = p_status WHERE id = ANY(v_shipment_ids);
      
      IF p_status = 'paid' THEN
        UPDATE orders SET invoice_payment_status = 'partially_paid' 
        WHERE shipment_id = ANY(v_shipment_ids) AND invoice_payment_status != 'paid';
      ELSIF p_status = 'not_paid' THEN
        UPDATE orders SET invoice_payment_status = 'not_paid' 
        WHERE shipment_id = ANY(v_shipment_ids) AND invoice_payment_status != 'paid';
      END IF;
    ELSE
      -- Code match fallback
      UPDATE shipments SET invoice_payment_status = p_status 
      WHERE code = REPLACE(REPLACE(REPLACE(p_invoice_number, 'INV-DISP-', ''), 'INV-SETTLE-', ''), 'INV-KBB-', '');
      
      IF p_status = 'paid' THEN
        UPDATE orders SET invoice_payment_status = 'partially_paid' 
        WHERE shipment_id IN (
          SELECT id FROM shipments WHERE code = REPLACE(REPLACE(REPLACE(p_invoice_number, 'INV-DISP-', ''), 'INV-SETTLE-', ''), 'INV-KBB-', '')
        ) AND invoice_payment_status != 'paid';
      ELSIF p_status = 'not_paid' THEN
        UPDATE orders SET invoice_payment_status = 'not_paid' 
        WHERE shipment_id IN (
          SELECT id FROM shipments WHERE code = REPLACE(REPLACE(REPLACE(p_invoice_number, 'INV-DISP-', ''), 'INV-SETTLE-', ''), 'INV-KBB-', '')
        ) AND invoice_payment_status != 'paid';
      END IF;
    END IF;
  END IF;

  -- Final settlement invoice handling
  IF v_invoice_type = 'final_settlement' OR p_invoice_number LIKE 'INV-SETTLE-%' THEN
    IF v_order_ids IS NOT NULL AND array_length(v_order_ids, 1) > 0 THEN
      IF p_status = 'paid' THEN
        UPDATE orders SET invoice_payment_status = 'paid' WHERE id = ANY(v_order_ids);
      ELSE
        UPDATE orders SET invoice_payment_status = 'partially_paid' WHERE id = ANY(v_order_ids);
      END IF;
    END IF;

    IF v_shipment_ids IS NOT NULL AND array_length(v_shipment_ids, 1) > 0 THEN
      IF p_status = 'paid' THEN
        UPDATE orders SET invoice_payment_status = 'paid' WHERE shipment_id = ANY(v_shipment_ids);
      ELSE
        UPDATE orders SET invoice_payment_status = 'partially_paid' WHERE shipment_id = ANY(v_shipment_ids);
      END IF;
    END IF;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION set_invoice_payment_status(text, invoice_payment_status) TO authenticated;
