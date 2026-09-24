import type { InboundStatus, OrderStatus, ShipmentStatus } from "./types";

/** Who acts next. Internal panel, so real party names are used. */
export type StatusGroup = "brand" | "kbb" | "v360" | "transit" | "done" | "problem" | "closed";

export const STATUS: Record<OrderStatus, { label: string; group: StatusGroup }> = {
  new:                    { label: "New", group: "kbb" },
  confirmation_pending:   { label: "Confirmation pending", group: "kbb" },
  customer_unreachable:   { label: "Customer unreachable", group: "kbb" },
  needs_amendment:        { label: "Needs amendment", group: "brand" },
  brand_confirmed:        { label: "Brand confirmed", group: "brand" },
  confirmed:              { label: "Confirmed", group: "brand" },
  cancelled:              { label: "Cancelled", group: "closed" },
  brand_preparing:        { label: "Brand preparing", group: "brand" },
  dispatched_to_hub:      { label: "Dispatched to hub", group: "v360" },
  received_at_hub:        { label: "Received at hub", group: "v360" },
  hub_issue:              { label: "Hub issue", group: "problem" },
  ready_for_shipment:     { label: "Ready for shipment", group: "v360" },
  assigned_to_shipment:   { label: "In a shipment", group: "v360" },
  shipped:                { label: "Shipped", group: "transit" },
  in_transit:             { label: "In transit", group: "transit" },
  customs:                { label: "Customs / clearance", group: "transit" },
  arrived_bd:             { label: "Arrived in Bangladesh", group: "kbb" },
  received_by_partner:    { label: "Received by KBB", group: "kbb" },
  preparing_for_delivery: { label: "Preparing for delivery", group: "kbb" },
  out_for_delivery:       { label: "Out for delivery", group: "kbb" },
  delivered:              { label: "Delivered", group: "done" },
  delivery_failed:        { label: "Delivery failed", group: "problem" },
  returned:               { label: "Returned", group: "problem" },
  hold:                   { label: "On hold", group: "problem" },
};

export const GROUP_LABEL: Record<StatusGroup, string> = {
  brand: "With brand", kbb: "With KBB", v360: "With V360", transit: "In transit",
  done: "Delivered", problem: "Problem", closed: "Cancelled",
};

export const GROUP_CLASSES: Record<StatusGroup, { text: string; bg: string; dot: string }> = {
  brand:   { text: "text-g-brand",   bg: "bg-g-brand-bg",   dot: "bg-g-brand" },
  kbb:     { text: "text-g-kbb",     bg: "bg-g-kbb-bg",     dot: "bg-g-kbb" },
  v360:    { text: "text-g-v360",    bg: "bg-g-v360-bg",    dot: "bg-g-v360" },
  transit: { text: "text-g-transit", bg: "bg-g-transit-bg", dot: "bg-g-transit" },
  done:    { text: "text-g-done",    bg: "bg-g-done-bg",    dot: "bg-g-done" },
  problem: { text: "text-g-problem", bg: "bg-g-problem-bg", dot: "bg-g-problem" },
  closed:  { text: "text-g-closed",  bg: "bg-g-closed-bg",  dot: "bg-g-closed" },
};

export const CONFIRM_QUEUE: OrderStatus[] = ["new", "confirmation_pending", "customer_unreachable"];
export const DELIVERY_QUEUE: OrderStatus[] = ["received_by_partner", "preparing_for_delivery", "out_for_delivery", "delivery_failed"];
export const TERMINAL: OrderStatus[] = ["delivered", "cancelled", "returned"];
/** Statuses set only by their own dedicated action, never by the generic status buttons. */
export const DEDICATED: OrderStatus[] = ["dispatched_to_hub", "received_at_hub", "hub_issue", "assigned_to_shipment",
  "shipped", "in_transit", "customs", "arrived_bd", "received_by_partner", "delivered", "hold"];
export const NOTE_REQUIRED: OrderStatus[] = ["cancelled", "delivery_failed", "needs_amendment"];

/** Order-list filter presets for V360. */
export const ORDER_VIEWS: { key: string; label: string; statuses: OrderStatus[] | null }[] = [
  { key: "all", label: "All", statuses: null },
  { key: "kbb", label: "Confirming", statuses: CONFIRM_QUEUE },
  { key: "brand", label: "With brand", statuses: ["needs_amendment", "confirmed", "brand_confirmed", "brand_preparing"] },
  { key: "hub", label: "Hub", statuses: ["dispatched_to_hub", "received_at_hub", "hub_issue", "ready_for_shipment", "assigned_to_shipment"] },
  { key: "transit", label: "In transit", statuses: ["shipped", "in_transit", "customs", "arrived_bd"] },
  { key: "lastmile", label: "Last mile", statuses: ["received_by_partner", "preparing_for_delivery", "out_for_delivery"] },
  { key: "problem", label: "Problems", statuses: ["hub_issue", "delivery_failed", "returned", "hold"] },
  { key: "delivered", label: "Delivered", statuses: ["delivered"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];

/** Full status tracks for the order-screen tracking bar, per organisation.
 * Every step is shown (done, current, upcoming) so the whole journey is visible. */
export interface TrackStep { status: OrderStatus; label: string }

export const V360_STATUS_TRACK: TrackStep[] = [
  { status: "new", label: "New" },
  { status: "brand_confirmed", label: "Brand confirmed" },
  { status: "confirmed", label: "Fulfilment verified" },
  { status: "dispatched_to_hub", label: "Shipped to hub" },
  { status: "received_at_hub", label: "Received at hub" },
  { status: "shipped", label: "Dispatched" },
  { status: "arrived_bd", label: "Arrived BD" },
  { status: "out_for_delivery", label: "Out for delivery" },
  { status: "delivered", label: "Delivered" },
];

export const PARTNER_STATUS_TRACK: TrackStep[] = [
  { status: "new", label: "New" },
  { status: "brand_confirmed", label: "Confirm from brand" },
  { status: "confirmed", label: "Confirmed by Fulfilment" },
  { status: "cancelled", label: "Cancelled" },
  { status: "needs_amendment", label: "Amendment + addition" },
  { status: "out_for_delivery", label: "Out for delivery" },
  { status: "delivered", label: "Delivered" },
];

export const JOURNEY: { key: string; label: string; statuses: OrderStatus[] }[] = [
  { key: "confirm", label: "Confirm", statuses: ["new", "confirmation_pending", "customer_unreachable", "needs_amendment"] },
  { key: "prepare", label: "Brand", statuses: ["confirmed", "brand_confirmed", "brand_preparing"] },
  { key: "hub", label: "V360 hub", statuses: ["dispatched_to_hub", "received_at_hub", "hub_issue", "ready_for_shipment", "assigned_to_shipment"] },
  { key: "shipment", label: "To Bangladesh", statuses: ["shipped", "in_transit", "customs", "arrived_bd"] },
  { key: "bd", label: "KBB delivery", statuses: ["received_by_partner", "preparing_for_delivery", "out_for_delivery", "delivery_failed", "returned"] },
  { key: "delivered", label: "Delivered", statuses: ["delivered"] },
];
export function journeyIndex(status: OrderStatus): number {
  return JOURNEY.findIndex((leg) => leg.statuses.includes(status));
}

export const SHIPMENT_FLOW: ShipmentStatus[] = ["draft", "ready_for_dispatch", "handed_to_carrier", "in_transit", "customs", "arrived_bd", "received_by_partner"];
/** V360 view skips in_transit and customs — handed_to_carrier goes straight to arrived_bd. */
export const V360_SHIPMENT_FLOW: ShipmentStatus[] = ["draft", "ready_for_dispatch", "handed_to_carrier", "arrived_bd", "received_by_partner"];
export const SHIPMENT_STATUS: Record<ShipmentStatus, { label: string; group: StatusGroup }> = {
  draft: { label: "Draft", group: "v360" },
  ready_for_dispatch: { label: "Ready to dispatch", group: "v360" },
  handed_to_carrier: { label: "Handed to carrier", group: "transit" },
  in_transit: { label: "In transit", group: "transit" },
  customs: { label: "Customs / clearance", group: "transit" },
  arrived_bd: { label: "Arrived in Bangladesh", group: "kbb" },
  received_by_partner: { label: "Received by KBB", group: "done" },
};
export function nextShipmentStatus(s: ShipmentStatus): ShipmentStatus | null {
  const i = SHIPMENT_FLOW.indexOf(s);
  return i >= 0 && i < SHIPMENT_FLOW.length - 1 ? SHIPMENT_FLOW[i + 1] : null;
}
/** For V360: skips in_transit and customs. Legacy shipments in those states jump to arrived_bd. */
export function nextV360ShipmentStatus(s: ShipmentStatus): ShipmentStatus | null {
  if (s === "in_transit" || s === "customs") return "arrived_bd";
  const i = V360_SHIPMENT_FLOW.indexOf(s);
  return i >= 0 && i < V360_SHIPMENT_FLOW.length - 1 ? V360_SHIPMENT_FLOW[i + 1] : null;
}

export const INBOUND_STATUS: Record<InboundStatus, { label: string; group: StatusGroup }> = {
  in_transit: { label: "Awaiting receipt", group: "v360" },
  received: { label: "Received", group: "done" },
  issue: { label: "Mismatch", group: "problem" },
};

export const RETURN_DISPOSITION: Record<string, string> = {
  pending: "Decision pending", restock_in_bd: "Restock in Bangladesh", return_to_pk: "Return to Pakistan", written_off: "Written off",
};

export const ROLE_LABEL: Record<string, string> = {
  admin: "V360 admin", operator: "V360 operator", partner_agent: "KBB agent", brand_owner: "Brand owner", brand_staff: "Brand staff",
};
