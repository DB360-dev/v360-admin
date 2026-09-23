export type OrderStatus =
  | "new" | "confirmation_pending" | "customer_unreachable" | "needs_amendment" | "confirmed" | "cancelled"
  | "brand_preparing" | "dispatched_to_hub" | "received_at_hub" | "hub_issue" | "ready_for_shipment"
  | "assigned_to_shipment" | "shipped" | "in_transit" | "customs" | "arrived_bd" | "received_by_partner"
  | "preparing_for_delivery" | "out_for_delivery" | "delivered" | "delivery_failed" | "returned" | "hold";

export type ShipmentStatus =
  | "draft" | "ready_for_dispatch" | "handed_to_carrier" | "in_transit" | "customs" | "arrived_bd" | "received_by_partner";

export type InboundStatus = "in_transit" | "received" | "issue";
export type MemberRole = "admin" | "operator" | "partner_agent" | "brand_owner" | "brand_staff";
export type OrgType = "v360" | "partner" | "brand";

export type ApprovalStatus = "pending" | "approved" | "rejected";
export interface Organization {
  id: string; name: string; type: OrgType; slug: string | null; is_active: boolean;
  approval_status: ApprovalStatus; review_note: string | null;
}
export interface Membership { role: MemberRole; organization: Organization }

export interface Order {
  id: string; brand_id: string; shopify_order_id: number; order_number: string; order_date: string;
  customer_name: string | null; customer_phone: string | null; customer_email: string | null;
  address1: string | null; address2: string | null; city: string | null; province: string | null; zip: string | null;
  country_code: string; currency: string; subtotal: number; discount_total: number; shipping_total: number;
  order_total: number; payment_status: string | null; cod_amount_expected: number | null;
  cod_amount_collected: number | null; cod_currency: string | null; customer_note: string | null; shopify_note: string | null;
  status: OrderStatus; previous_status: OrderStatus | null; status_changed_at: string; confirmation_attempts: number;
  confirmed_at: string | null; inbound_batch_id: string | null; received_at_hub_at: string | null; hub_notes: string | null;
  shipment_id: string | null; delivery_courier: string | null; delivery_tracking_number: string | null;
  delivered_at: string | null; failure_reason: string | null; return_disposition: string | null;
  shopify_cancelled_at: string | null; created_at: string;
  confirmed_by: string | null;
  brand_confirmed_at: string | null; brand_confirmed_by: string | null;
}

export interface OrderItem {
  id: string; order_id: string; product_name: string; sku: string | null; variant: string | null;
  quantity: number; unit_price: number; discount: number; received_quantity: number;
}

export interface InboundBatch {
  id: string; brand_id: string; courier: string; tracking_number: string | null; dispatch_date: string;
  status: InboundStatus; courier_status: string | null; notes: string | null; created_at: string; received_at: string | null;
}
export interface InboundBatchOverview extends InboundBatch {
  order_count: number; awaiting_count: number; issue_count: number; received_count: number;
}

export interface Shipment {
  id: string; code: string; shipping_partner: string | null; tracking_number: string | null;
  origin: string; destination: string; status: ShipmentStatus; dispatched_at: string | null; received_at: string | null;
}

export interface OrderDetail extends Order {
  order_items: OrderItem[];
  inbound_batch: InboundBatch | null;
  shipment: Shipment | null;
}

export interface OrderEvent {
  id: number; order_id: string; actor_label: string | null; action: string;
  from_status: OrderStatus | null; to_status: OrderStatus | null; note: string | null; created_at: string;
}

export interface OrderMessage {
  id: number;
  order_id: string;
  sender_type: "brand" | "admin";
  sender_label: string;
  body: string;
  read_by_brand: boolean;
  read_by_admin: boolean;
  created_at: string;
}

export interface OrderOverview {
  id: string; order_number: string; order_date: string; status: OrderStatus; status_changed_at: string;
  brand_id: string; brand_name: string; customer_name: string | null; customer_phone: string | null; city: string | null;
  order_total: number; currency: string; cod_amount_expected: number | null; cod_amount_collected: number | null;
  cod_currency: string | null; confirmation_attempts: number; inbound_courier: string | null; inbound_tracking: string | null;
  shipment_code: string | null; shipment_tracking: string | null; shipping_partner: string | null;
  delivery_courier: string | null; delivery_tracking_number: string | null; delivered_at: string | null; item_count: number;
  shipment_id: string | null; inbound_batch_id: string | null;
}

export interface ShopifyConnection {
  id: string; brand_id: string; shop_domain: string; scopes: string | null; status: string;
  last_synced_at: string | null; installed_at: string | null;
}

export interface OpsOrderDetail extends OrderDetail { brand: { name: string } | null }

export interface InboundBatchAdmin extends InboundBatchOverview { brand_name: string }

export interface ShipmentOverview {
  id: string; code: string; shipping_partner: string | null; tracking_number: string | null;
  origin: string; destination: string; total_weight_kg: number | null; status: ShipmentStatus; notes: string | null;
  created_at: string; dispatched_at: string | null; received_at: string | null;
  order_count: number; brand_count: number; cod_expected: number;
}

export interface ShipmentEvent {
  id: number; shipment_id: string; action: string; from_status: ShipmentStatus | null;
  to_status: ShipmentStatus | null; note: string | null; created_at: string;
}

export interface TeamMember {
  membership_id: string; user_id: string; role: MemberRole; created_at: string;
  full_name: string | null; email: string | null; phone: string | null;
  organization_id: string; organization_name: string; organization_type: OrgType;
}

export interface BrandRow extends Organization {
  created_at: string; contact_phone: string | null; reviewed_at: string | null;
  shopify_connections: { shop_domain: string; status: string; last_synced_at: string | null }[] | { shop_domain: string; status: string; last_synced_at: string | null } | null;
}

export interface FxRate { id: number; rate_date: string; base: string; quote: string; rate: number; note: string | null; created_at: string }

export interface WebhookEvent {
  id: number; webhook_id: string; topic: string; shop_domain: string; received_at: string; processed_at: string | null; error: string | null;
}

export interface StatusTransition { from_status: OrderStatus; to_status: OrderStatus; actor: "partner" | "brand" | "v360" }

export type ReturnDispositionValue = "pending" | "restock_in_bd" | "return_to_pk" | "written_off";

// ---------------------------------------------------------------- money

/** Role-filtered view of money_settings — forbidden keys are omitted. */
export interface MoneySettings {
  kbb_commission_pct?: number;
  v360_commission_pct?: number;
  freight_bdt_per_kg?: number;
  invoice_company_name?: string | null;
}

export interface BrandPayable {
  brand_id: string;
  brand_name: string;
  order_count: number;
  order_total_sum: number;
  commission_sum: number;
  freight_sum: number;
  payable_sum: number;
}

export interface SettlementLine {
  id: number;
  settlement_id: number;
  order_id: string;
  order_number: string;
  order_total: number;
  commission: number;
  freight_share_pkr: number;
  freight_fx_rate: number | null;
  freight_rate_date: string | null;
  brand_payable: number;
  delivered_at: string;
}

export interface Settlement {
  id: number;
  brand_id: string;
  kind: "monthly" | "manual";
  period_start: string | null;
  period_end: string | null;
  status: "issued" | "paid";
  order_count: number;
  total_order_total: number;
  total_commission: number;
  total_freight: number;
  total_payable: number;
  commission_pct: number;
  note: string | null;
  created_at: string;
  paid_at: string | null;
  brand?: { name: string } | null;
  settlement_lines?: SettlementLine[];
}

export interface KbbShipmentAccount {
  shipment_id: string;
  shipment_code: string;
  shipment_status: ShipmentStatus;
  dispatched_at: string | null;
  advance_owed: number;
  advance_paid: number;
  delivery_owed: number;
  delivery_paid: number;
  credits: number;
  net_balance: number;
}

export type KbbPaymentKind = "dispatch_advance" | "delivery_balance" | "credit";

export interface KbbPayment {
  id: number;
  kind: KbbPaymentKind;
  shipment_id: string | null;
  order_id: string | null;
  amount: number;
  currency: string;
  fx_rate: number | null;
  amount_pkr: number;
  payment_date: string;
  note: string | null;
  created_at: string;
  shipment?: { code: string } | null;
  order?: { order_number: string } | null;
}

export interface ShipmentBrandWeight {
  id: number;
  shipment_id: string;
  brand_id: string;
  weight_kg: number;
  freight_bdt_per_kg: number;
  fx_rate: number;
  fx_rate_date: string;
  created_at: string;
  updated_at: string;
}
