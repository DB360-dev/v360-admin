import type { OrderStatus } from "./types";

/** Every permission a custom role can grant. Mirrors the `permissions` table (migration 049). */
export type Perm =
  | "orders.view" | "orders.view_money" | "orders.hold" | "orders.cancel" | "orders.add_note" | "orders.internal_notes"
  | "orders.messages" | "orders.edit_customer" | "orders.return_decision" | "orders.override_status"
  | "confirmations.view" | "confirmations.manage"
  | "hub.view" | "hub.receive"
  | "shipments.view" | "shipments.create" | "shipments.edit_orders" | "shipments.edit_details" | "shipments.update_status"
  | "shipments.freight_weights" | "shipments.receive"
  | "bd.receive" | "discrepancies.view" | "discrepancies.override" | "discrepancies.resolve"
  | "inventory.view"
  | "deliveries.view" | "deliveries.manage"
  | "invoices.view" | "invoices.create" | "invoices.payment_status" | "invoices.recalculate" | "invoices.delete"
  | "money.view" | "money.record_payment" | "money.statements" | "money.settings"
  | "brands.view" | "brands.approve" | "brands.settings"
  | "fx.view" | "fx.manage"
  | "webhooks.view" | "webhooks.replay"
  | "activity.view"
  | "couriers.manage"
  | ReportPerm;

/** One permission per report (migration 052). */
export type ReportPerm =
  | "reports.order_register" | "reports.status_snapshot" | "reports.order_ageing" | "reports.turnaround" | "reports.sku_sales"
  | "reports.cancellations_holds" | "reports.status_history" | "reports.brand_dispatches" | "reports.hub_receiving" | "reports.hub_issues"
  | "reports.shipment_register" | "reports.shipment_manifest" | "reports.transit_performance" | "reports.incoming_shipments"
  | "reports.confirmations" | "reports.agent_productivity" | "reports.bd_discrepancies" | "reports.delivery_sheet"
  | "reports.delivery_performance" | "reports.cod_collection" | "reports.returns" | "reports.stock"
  | "reports.invoice_register" | "reports.unpaid_ageing" | "reports.brand_payables" | "reports.kbb_ledger"
  | "reports.shipping_charges" | "reports.commissions" | "reports.revenue" | "reports.fx_history"
  | "reports.brand_scorecard" | "reports.shopify_sync" | "reports.users_access";

/** Permission a status move needs. Same map as transition_perm() in the database. */
export function transitionPerm(to: OrderStatus): Perm {
  if (to === "confirmation_pending" || to === "confirmed" || to === "customer_unreachable" || to === "needs_amendment") return "confirmations.manage";
  if (to === "cancelled") return "orders.cancel";
  if (to === "ready_for_shipment") return "hub.receive";
  if (to === "preparing_for_delivery" || to === "out_for_delivery" || to === "delivery_failed" || to === "returned") return "deliveries.manage";
  return "orders.override_status";
}

/** Permissions that only exist for V360 staff (applies_to = {v360} in the catalog). */
const V360_ONLY = new Set<Perm>([
  "orders.edit_customer", "orders.return_decision", "orders.override_status",
  "hub.view", "hub.receive",
  "shipments.create", "shipments.edit_orders", "shipments.edit_details", "shipments.update_status", "shipments.freight_weights",
  "discrepancies.override", "discrepancies.resolve",
  "invoices.recalculate", "invoices.delete",
  "money.record_payment", "money.statements", "money.settings",
  "brands.view", "brands.approve", "brands.settings",
  "fx.view", "fx.manage",
  "webhooks.view", "webhooks.replay",
  "activity.view",
  "reports.order_register", "reports.status_snapshot", "reports.order_ageing", "reports.turnaround", "reports.sku_sales",
  "reports.cancellations_holds", "reports.status_history", "reports.brand_dispatches", "reports.hub_receiving", "reports.hub_issues",
  "reports.shipment_register", "reports.shipment_manifest", "reports.transit_performance",
  "reports.invoice_register", "reports.unpaid_ageing", "reports.brand_payables", "reports.shipping_charges",
  "reports.commissions", "reports.revenue", "reports.fx_history", "reports.brand_scorecard", "reports.shopify_sync",
]);

/** Permissions that only exist for KBB staff (applies_to = {partner}). */
const KBB_ONLY = new Set<Perm>(["shipments.receive", "couriers.manage", "reports.incoming_shipments", "reports.agent_productivity", "reports.delivery_sheet"]);

/** Whether a permission exists for this side at all. Built-in admins get every permission of their own side only. */
export function permAppliesTo(perm: Perm, side: "v360" | "kbb"): boolean {
  return side === "v360" ? !KBB_ONLY.has(perm) : !V360_ONLY.has(perm);
}
