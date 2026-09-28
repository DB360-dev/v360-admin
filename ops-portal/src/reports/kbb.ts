/**
 * KBB (Bangladesh fulfilment partner) reports: confirmation, receiving,
 * delivery, cash, returns, stock, KBB's own account and team.
 *
 * Never reads brand payout invoices, brand shipping charges or payout candidates.
 */
import { supabase } from "@/lib/supabase";
import type {
  InvoiceRecord, KbbOrderAccount, KbbPayment, OrderEvent, OrderOverview, OrderStatus,
  PermissionDef, ShipmentOverview, TeamMember,
} from "@/lib/types";
import type { Column, Row } from "@/lib/excel";
import type { BdDiscrepancy, DispatchedItem, InventoryOrderItem, RestockedItem } from "@/hooks/useData";
import { DELIVERY_QUEUE, RETURN_DISPOSITION, STATUS } from "@/lib/status";
import type { ReportDef } from "./types";
import { loadEvents } from "./v360Orders";
import { avg, chunk, daysBetween, fetchAll, fig, filterLines, groupBy, inRange, median, ratio, statusLabel, sum, within } from "./util";

// ---------------------------------------------------------------- shared helpers

const CAT = { confirm: "Confirmation", receive: "Receiving", delivery: "Delivery", stock: "Stock & account", team: "Team" };

const byOrderNo = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const nowIso = () => new Date().toISOString();
const text = (v: string | null | undefined) => (v ?? "").trim();
/** Query builders are left untyped: rows are typed by the fetchAll<T> call (the select parser can't type embeds without generated DB types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = any;
const table = (name: string): AnyQuery => supabase.from(name);
const moneyCol = (header: string, key: string): Column => ({ header, key, type: "money", money: true });
const numCol = (header: string, key: string, width?: number): Column => ({ header, key, type: "number", width });

/** Standard "label / orders" breakdown, largest first. */
function countBreakdown<T>(name: string, header: string, xs: T[], key: (x: T) => string) {
  const rows = [...groupBy(xs, key)].map(([k, g]) => ({ key: k, count: g.length, share: ratio(g.length, xs.length) }))
    .sort((a, b) => b.count - a.count);
  return {
    name,
    columns: [{ header, key: "key" }, numCol("Orders", "count"), { header: "Share", key: "share", type: "percent" as const }],
    rows,
  };
}

interface Person { name: string; org: string }

/** user id / name / email → person, from team_members (empty when the viewer can't read it). */
async function loadPeople(): Promise<{ byId: Map<string, Person>; byLabel: Map<string, Person> }> {
  const byId = new Map<string, Person>();
  const byLabel = new Map<string, Person>();
  try {
    const rows = await fetchAll<Pick<TeamMember, "membership_id" | "user_id" | "full_name" | "email" | "organization_name" | "organization_type">>((from, to) =>
      table("team_members").select("membership_id, user_id, full_name, email, organization_name, organization_type")
        .order("membership_id").range(from, to));
    for (const m of rows) {
      const p = { name: m.full_name || m.email || m.user_id, org: m.organization_name };
      byId.set(m.user_id, p);
      if (m.full_name) byLabel.set(m.full_name.trim().toLowerCase(), p);
      if (m.email) byLabel.set(m.email.trim().toLowerCase(), p);
    }
  } catch {
    // Not readable for this viewer: names stay blank.
  }
  return { byId, byLabel };
}

type BrandRef = { name: string } | null;
const brandName = (b: BrandRef | BrandRef[] | undefined) => (Array.isArray(b) ? b[0]?.name : b?.name) ?? "";

// ---------------------------------------------------------------- K1 Confirmation report

interface ConfirmOrder {
  id: string; order_number: string; order_date: string; status: OrderStatus; status_changed_at: string;
  brand_id: string; customer_name: string | null; customer_phone: string | null; city: string | null;
  confirmation_attempts: number; confirmed_at: string | null; confirmed_by: string | null; brand: BrandRef;
}

const PRE_CONFIRM: OrderStatus[] = ["new", "confirmation_pending", "brand_confirmed", "hold"];

function confirmOutcome(o: ConfirmOrder): string {
  if (o.status === "cancelled") return "Cancelled";
  if (o.confirmed_at) return "Confirmed";
  if (o.status === "customer_unreachable") return "Unreachable";
  if (o.status === "needs_amendment") return "Needs amendment";
  if (PRE_CONFIRM.includes(o.status)) return "Pending";
  return "Confirmed"; // moved past confirmation without a recorded time
}

const confirmationReport: ReportDef = {
  code: "K1", perm: "reports.confirmations", side: "kbb", category: CAT.confirm,
  title: "Confirmation report",
  description: "Every order's confirmation outcome, call attempts, who confirmed it and how long it took.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const orders = await fetchAll<ConfirmOrder>((from, to) => {
      let q = table("orders").select("id, order_number, order_date, status, status_changed_at, brand_id, customer_name, customer_phone, city, confirmation_attempts, confirmed_at, confirmed_by, brand:organizations(name)");
      q = inRange(q, "order_date", f);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      return q.order("order_date", { ascending: true }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading orders… ${n.toLocaleString()}`));
    const people = await loadPeople();

    const rows = orders.map((o) => {
      const hours = o.confirmed_at ? Math.round(((new Date(o.confirmed_at).getTime() - new Date(o.order_date).getTime()) / 3_600_000) * 10) / 10 : null;
      return {
        order_number: o.order_number, order_date: o.order_date, brand_name: brandName(o.brand),
        customer_name: o.customer_name, customer_phone: o.customer_phone, city: o.city || "Unknown",
        outcome: confirmOutcome(o), status_label: statusLabel(o.status), attempts: o.confirmation_attempts ?? 0,
        confirmed_at: o.confirmed_at, hours, confirmed_by: o.confirmed_by ? people.byId.get(o.confirmed_by)?.name ?? "" : "",
      };
    });
    const hours = rows.map((r) => r.hours).filter((h): h is number => h !== null && h >= 0);
    const count = (k: string) => rows.filter((r) => r.outcome === k).length;
    const byBrand = [...groupBy(rows, (r) => r.brand_name)].map(([b, rs]) => ({
      brand: b, orders: rs.length, confirmed: rs.filter((r) => r.outcome === "Confirmed").length,
      cancelled: rs.filter((r) => r.outcome === "Cancelled").length, rate: ratio(rs.filter((r) => r.outcome === "Confirmed").length, rs.length),
    })).sort((a, b) => b.orders - a.orders);
    const byCity = [...groupBy(rows, (r) => r.city)].map(([c, rs]) => ({
      city: c, orders: rs.length, confirmed: rs.filter((r) => r.outcome === "Confirmed").length,
      unreachable: rs.filter((r) => r.outcome === "Unreachable").length, rate: ratio(rs.filter((r) => r.outcome === "Confirmed").length, rs.length),
    })).sort((a, b) => b.orders - a.orders);

    return {
      title: "Confirmation report",
      filters: filterLines(f),
      notes: people.byId.size ? [] : ["Team names aren't visible to you, so 'Confirmed by' is blank."],
      figures: [
        fig("Orders", rows.length),
        fig("Confirmed", count("Confirmed")),
        fig("Cancelled", count("Cancelled")),
        fig("Unreachable", count("Unreachable")),
        fig("Needs amendment", count("Needs amendment")),
        fig("Pending", count("Pending")),
        fig("Confirmation rate", ratio(count("Confirmed"), rows.length), "percent"),
        fig("Average attempts", avg(rows.map((r) => r.attempts)), "days"),
        fig("Median hours to confirm", median(hours), "days"),
      ],
      breakdowns: [
        countBreakdown("By outcome", "Outcome", rows, (r) => r.outcome),
        { name: "By brand", columns: [{ header: "Brand", key: "brand" }, numCol("Orders", "orders"), numCol("Confirmed", "confirmed"), numCol("Cancelled", "cancelled"), { header: "Confirmed %", key: "rate", type: "percent" }], rows: byBrand },
        { name: "By city", columns: [{ header: "City", key: "city" }, numCol("Orders", "orders"), numCol("Confirmed", "confirmed"), numCol("Unreachable", "unreachable"), { header: "Confirmed %", key: "rate", type: "percent" }], rows: byCity },
      ],
      sheets: [{
        name: "Orders",
        columns: [
          { header: "Order", key: "order_number", width: 14 },
          { header: "Order date", key: "order_date", type: "datetime" },
          { header: "Brand", key: "brand_name" },
          { header: "Customer", key: "customer_name" },
          { header: "Phone", key: "customer_phone", width: 16 },
          { header: "City", key: "city", width: 16 },
          { header: "Outcome", key: "outcome", width: 16 },
          { header: "Current status", key: "status_label", width: 20 },
          numCol("Attempts", "attempts", 9),
          { header: "Confirmed at", key: "confirmed_at", type: "datetime" },
          { header: "Hours to confirm", key: "hours", type: "days", width: 12 },
          { header: "Confirmed by", key: "confirmed_by" },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- K2 Agent productivity

const DELIVERY_ACTIONS: OrderStatus[] = ["out_for_delivery", "delivered", "delivery_failed", "returned"];

const agentProductivity: ReportDef = {
  code: "K2", perm: "reports.agent_productivity", side: "kbb", category: CAT.confirm,
  title: "Agent productivity",
  description: "Per staff member: orders confirmed and delivery actions (out for delivery, delivered, failed, returned).",
  filters: ["dateRange"],
  async run(f, ctx) {
    const confirmed = await fetchAll<{ id: string; confirmed_at: string; confirmed_by: string | null }>((from, to) => {
      let q = table("orders").select("id, confirmed_at, confirmed_by").not("confirmed_at", "is", null);
      q = inRange(q, "confirmed_at", f);
      return q.order("confirmed_at", { ascending: true }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading confirmations… ${n.toLocaleString()}`));
    const events = await fetchAll<Pick<OrderEvent, "id" | "order_id" | "actor_label" | "to_status" | "created_at">>((from, to) => {
      let q = table("order_events").select("id, order_id, actor_label, to_status, created_at").in("to_status", DELIVERY_ACTIONS);
      q = inRange(q, "created_at", f);
      return q.order("id").range(from, to);
    }, (n) => ctx.progress(`Loading delivery actions… ${n.toLocaleString()}`));
    const people = await loadPeople();

    type Agg = { person: string; org: string; confirmed: number; out_for_delivery: number; delivered: number; delivery_failed: number; returned: number };
    const agg = new Map<string, Agg>();
    const daily = new Map<string, { day: string; person: string; confirmed: number; delivery: number }>();
    const get = (p: Person) => {
      const key = p.name.toLowerCase();
      let a = agg.get(key);
      if (!a) { a = { person: p.name, org: p.org, confirmed: 0, out_for_delivery: 0, delivered: 0, delivery_failed: 0, returned: 0 }; agg.set(key, a); }
      if (!a.org && p.org) a.org = p.org;
      return a;
    };
    const day = (p: Person, d: string) => {
      const k = `${d.slice(0, 10)}|${p.name.toLowerCase()}`;
      let x = daily.get(k);
      if (!x) { x = { day: d.slice(0, 10), person: p.name, confirmed: 0, delivery: 0 }; daily.set(k, x); }
      return x;
    };

    for (const o of confirmed) {
      const p = o.confirmed_by ? people.byId.get(o.confirmed_by) ?? { name: `User ${o.confirmed_by.slice(0, 8)}`, org: "" } : { name: "(not recorded)", org: "" };
      get(p).confirmed++;
      day(p, o.confirmed_at).confirmed++;
    }
    for (const e of events) {
      const label = text(e.actor_label);
      const p = label ? people.byLabel.get(label.toLowerCase()) ?? { name: label, org: "" } : { name: "(not recorded)", org: "" };
      const a = get(p);
      if (e.to_status === "out_for_delivery") a.out_for_delivery++;
      else if (e.to_status === "delivered") a.delivered++;
      else if (e.to_status === "delivery_failed") a.delivery_failed++;
      else if (e.to_status === "returned") a.returned++;
      day(p, e.created_at).delivery++;
    }
    const rows = [...agg.values()].map((a) => {
      const delivery = a.out_for_delivery + a.delivered + a.delivery_failed + a.returned;
      return { ...a, delivery, total: a.confirmed + delivery };
    }).sort((a, b) => b.total - a.total);
    const dailyRows = [...daily.values()].sort((a, b) => a.day.localeCompare(b.day) || a.person.localeCompare(b.person));

    return {
      title: "Agent productivity",
      filters: filterLines(f),
      notes: [
        "Confirmations are counted by the person recorded on the order (confirmed by). Delivery actions are counted from order history by the name recorded on each event (actor label), since history doesn't store a user id.",
        ...(people.byId.size ? [] : ["Team names aren't visible to you, so confirmers show as user ids."]),
      ],
      figures: [
        fig("Staff with activity", rows.filter((r) => r.person !== "(not recorded)").length),
        fig("Orders confirmed", sum(rows.map((r) => r.confirmed))),
        fig("Out for delivery", sum(rows.map((r) => r.out_for_delivery))),
        fig("Delivered", sum(rows.map((r) => r.delivered))),
        fig("Delivery failed", sum(rows.map((r) => r.delivery_failed))),
        fig("Returned", sum(rows.map((r) => r.returned))),
      ],
      sheets: [
        {
          name: "By staff member",
          columns: [
            { header: "Staff member", key: "person", width: 26 },
            { header: "Organization", key: "org", width: 14 },
            numCol("Orders confirmed", "confirmed", 14),
            numCol("Out for delivery", "out_for_delivery", 14),
            numCol("Delivered", "delivered"),
            numCol("Delivery failed", "delivery_failed", 14),
            numCol("Returned", "returned"),
            numCol("Delivery actions", "delivery", 14),
            numCol("Total actions", "total"),
          ],
          rows,
        },
        {
          name: "By day",
          columns: [{ header: "Day", key: "day", type: "date" }, { header: "Staff member", key: "person", width: 26 }, numCol("Confirmed", "confirmed"), numCol("Delivery actions", "delivery", 14)],
          rows: dailyRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- K3 Incoming shipments

const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  draft: "Draft", ready_for_dispatch: "Ready for dispatch", handed_to_carrier: "Handed to carrier", in_transit: "In transit",
  customs: "Customs", arrived_bd: "Arrived in Bangladesh", received_by_partner: "Received by KBB",
};

const incomingShipments: ReportDef = {
  code: "K3", perm: "reports.incoming_shipments", side: "kbb", category: CAT.receive,
  title: "Incoming shipments",
  description: "Shipments on their way to or received in Bangladesh, with carrier, tracking and days in transit.",
  filters: ["dateRange"],
  async run(f, ctx) {
    const ships = await fetchAll<ShipmentOverview>((from, to) => {
      let q = table("shipment_overview").select("id, code, shipping_partner, tracking_number, status, order_count, dispatched_at, received_at, created_at");
      q = inRange(q, "dispatched_at", f);
      return q.order("dispatched_at", { ascending: true, nullsFirst: false }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading shipments… ${n.toLocaleString()}`));
    const now = nowIso();
    const rows = ships.map((s) => ({
      code: s.code, carrier: s.shipping_partner ?? "", tracking: s.tracking_number ?? "",
      status: SHIPMENT_STATUS_LABEL[s.status] ?? s.status, orders: s.order_count,
      dispatched_at: s.dispatched_at, received_at: s.received_at,
      transit: s.dispatched_at ? daysBetween(s.dispatched_at, s.received_at ?? now) : null,
      open: !s.received_at && s.status !== "received_by_partner",
    }));
    const doneTransit = rows.filter((r) => !r.open && r.transit !== null).map((r) => r.transit as number);
    const byCarrier = [...groupBy(rows, (r) => r.carrier || "Unknown")].map(([c, rs]) => ({
      carrier: c, shipments: rs.length, orders: sum(rs.map((r) => r.orders)),
      avg: avg(rs.filter((r) => !r.open && r.transit !== null).map((r) => r.transit as number)),
    })).sort((a, b) => b.shipments - a.shipments);
    const byStatus = [...groupBy(rows, (r) => r.status)].map(([s, rs]) => ({ status: s, shipments: rs.length, orders: sum(rs.map((r) => r.orders)) }))
      .sort((a, b) => b.shipments - a.shipments);

    return {
      title: "Incoming shipments",
      filters: filterLines(f, f.from || f.to ? ["Dates are the dispatch date."] : []),
      notes: ["Days in transit counts to today for shipments not yet received."],
      figures: [
        fig("Shipments", rows.length),
        fig("Orders on them", sum(rows.map((r) => r.orders))),
        fig("Still on the way", rows.filter((r) => r.open).length),
        fig("Received by KBB", rows.filter((r) => !r.open).length),
        fig("Average days in transit (received)", avg(doneTransit), "days"),
        fig("Median days in transit (received)", median(doneTransit), "days"),
      ],
      breakdowns: [
        { name: "By status", columns: [{ header: "Status", key: "status" }, numCol("Shipments", "shipments"), numCol("Orders", "orders")], rows: byStatus },
        { name: "By carrier", columns: [{ header: "Carrier", key: "carrier" }, numCol("Shipments", "shipments"), numCol("Orders", "orders"), { header: "Avg days in transit", key: "avg", type: "days" }], rows: byCarrier },
      ],
      sheets: [{
        name: "Shipments",
        columns: [
          { header: "Shipment", key: "code", width: 14 },
          { header: "Carrier", key: "carrier", width: 16 },
          { header: "Tracking", key: "tracking", width: 20 },
          { header: "Status", key: "status", width: 20 },
          numCol("Orders", "orders", 9),
          { header: "Dispatched", key: "dispatched_at", type: "datetime" },
          { header: "Received", key: "received_at", type: "datetime" },
          { header: "Days in transit", key: "transit", type: "days", width: 13 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- K4 Receiving discrepancies

const bdDiscrepancies: ReportDef = {
  code: "K4", perm: "reports.bd_discrepancies", side: "kbb", category: CAT.receive,
  title: "Receiving discrepancies",
  description: "Items that arrived short in Bangladesh: expected, received, short by, and whether it was resolved.",
  filters: ["dateRange", "shipment"],
  async run(f, ctx) {
    const items = await fetchAll<BdDiscrepancy>((from, to) => {
      let q = table("bd_discrepancy_items").select("*");
      q = inRange(q, "checked_at", f);
      if (f.shipmentId) q = q.eq("shipment_id", f.shipmentId);
      return q.order("checked_at", { ascending: true }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading discrepancies… ${n.toLocaleString()}`));
    const rows = items.map((d) => {
      const short = Math.max(0, Number(d.expected_qty) - Number(d.received_qty));
      return {
        ...d, short, order_status: statusLabel(d.order_status), brand_name: d.brand_name ?? "",
        resolved: d.resolved_at ? "Yes" : "No",
      };
    });
    const byShipment = [...groupBy(rows, (r) => r.shipment_code)].map(([s, rs]) => ({
      shipment: s, items: rs.length, expected: sum(rs.map((r) => r.expected_qty)), received: sum(rs.map((r) => r.received_qty)),
      short: sum(rs.map((r) => r.short)), open: rs.filter((r) => !r.resolved_at).length,
    })).sort((a, b) => b.short - a.short);
    const byBrand = [...groupBy(rows, (r) => r.brand_name || "Unknown")].map(([b, rs]) => ({
      brand: b, items: rs.length, short: sum(rs.map((r) => r.short)), open: rs.filter((r) => !r.resolved_at).length,
    })).sort((a, b) => b.short - a.short);

    return {
      title: "Receiving discrepancies",
      filters: filterLines(f, f.from || f.to ? ["Dates are when the item was checked in."] : []),
      figures: [
        fig("Short items", rows.length),
        fig("Orders affected", new Set(rows.map((r) => r.order_id)).size),
        fig("Units expected", sum(rows.map((r) => r.expected_qty))),
        fig("Units received", sum(rows.map((r) => r.received_qty))),
        fig("Units short", sum(rows.map((r) => r.short))),
        fig("Unresolved", rows.filter((r) => !r.resolved_at).length),
      ],
      breakdowns: [
        { name: "By shipment", columns: [{ header: "Shipment", key: "shipment" }, numCol("Items", "items"), numCol("Expected", "expected"), numCol("Received", "received"), numCol("Short", "short"), numCol("Unresolved", "open")], rows: byShipment },
        { name: "By brand", columns: [{ header: "Brand", key: "brand" }, numCol("Items", "items"), numCol("Units short", "short"), numCol("Unresolved", "open")], rows: byBrand },
      ],
      sheets: [{
        name: "Discrepancies",
        columns: [
          { header: "Checked", key: "checked_at", type: "datetime" },
          { header: "Shipment", key: "shipment_code", width: 12 },
          { header: "Order", key: "order_number", width: 14 },
          { header: "Order status", key: "order_status", width: 20 },
          { header: "Brand", key: "brand_name" },
          { header: "Product", key: "product_name", width: 30 },
          { header: "Variant", key: "variant", width: 16 },
          { header: "SKU", key: "sku", width: 16 },
          numCol("Expected", "expected_qty", 10),
          numCol("Received", "received_qty", 10),
          numCol("Short by", "short", 10),
          { header: "Receiving note", key: "note", width: 28 },
          { header: "Resolved", key: "resolved", width: 9 },
          { header: "Resolved at", key: "resolved_at", type: "datetime" },
          { header: "Resolved by", key: "resolved_by_name" },
          { header: "Resolution note", key: "resolution_note", width: 28 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- K5 Delivery sheet

interface DeliveryOrder {
  id: string; order_number: string; order_date: string; status: OrderStatus; status_changed_at: string; brand_id: string;
  customer_name: string | null; customer_phone: string | null;
  address1: string | null; address2: string | null; city: string | null; province: string | null; zip: string | null;
  delivery_courier: string | null; delivery_tracking_number: string | null; customer_note: string | null;
  cod_amount_expected: number | null; cod_amount_collected: number | null; cod_currency: string | null; currency: string;
  brand: BrandRef; order_items: { product_name: string; variant: string | null; sku: string | null; quantity: number }[];
}

const itemsSummary = (items: DeliveryOrder["order_items"]) =>
  items.map((i) => `${i.quantity}× ${i.product_name}${i.variant ? ` (${i.variant})` : ""}`).join("; ");

const deliverySheet: ReportDef = {
  code: "K5", perm: "reports.delivery_sheet", side: "kbb", category: CAT.delivery,
  title: "Delivery sheet",
  description: "Orders waiting for delivery with full address, items and cash to collect, sorted by city. Made to print for riders.",
  filters: ["brand"],
  async run(f, ctx) {
    const orders = await fetchAll<DeliveryOrder>((from, to) => {
      let q = table("orders").select("id, order_number, order_date, status, status_changed_at, brand_id, customer_name, customer_phone, address1, address2, city, province, zip, delivery_courier, delivery_tracking_number, customer_note, cod_amount_expected, cod_amount_collected, cod_currency, currency, brand:organizations(name), order_items(product_name, variant, sku, quantity)")
        .in("status", DELIVERY_QUEUE);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      return q.order("id").range(from, to);
    }, (n) => ctx.progress(`Loading orders… ${n.toLocaleString()}`));
    const now = nowIso();
    const rows = orders.map((o) => ({
      order_number: o.order_number, brand_name: brandName(o.brand), customer_name: o.customer_name, customer_phone: o.customer_phone,
      address: [o.address1, o.address2, o.city, o.province, o.zip].map(text).filter(Boolean).join(", "),
      city: text(o.city) || "Unknown", items: itemsSummary(o.order_items ?? []), units: sum((o.order_items ?? []).map((i) => i.quantity)),
      courier: o.delivery_courier ?? "", tracking: o.delivery_tracking_number ?? "",
      cash: Math.max(0, Number(o.cod_amount_expected ?? 0) - Number(o.cod_amount_collected ?? 0)),
      currency: o.cod_currency ?? o.currency, status_label: statusLabel(o.status),
      waiting: daysBetween(o.status_changed_at, now), note: o.customer_note ?? "", rider_note: "",
    })).sort((a, b) => a.city.localeCompare(b.city) || byOrderNo(a.order_number, b.order_number));
    const byCity = [...groupBy(rows, (r) => r.city)].map(([c, rs]) => ({ city: c, orders: rs.length, cash: sum(rs.map((r) => r.cash)) }));
    const byStatus = [...groupBy(rows, (r) => r.status_label)].map(([s, rs]) => ({ status: s, orders: rs.length, cash: sum(rs.map((r) => r.cash)) }))
      .sort((a, b) => b.orders - a.orders);

    return {
      title: "Delivery sheet",
      filters: filterLines(f, [`Statuses: ${DELIVERY_QUEUE.map((s) => STATUS[s].label).join(", ")}`]),
      figures: [
        fig("Orders to deliver", rows.length),
        fig("Cities", byCity.length),
        fig("Cash to collect", sum(rows.map((r) => r.cash)), "money", true),
        fig("Failed, to retry or return", orders.filter((o) => o.status === "delivery_failed").length),
      ],
      breakdowns: [
        { name: "By city", columns: [{ header: "City", key: "city" }, numCol("Orders", "orders"), moneyCol("Cash to collect", "cash")], rows: byCity },
        { name: "By status", columns: [{ header: "Status", key: "status" }, numCol("Orders", "orders"), moneyCol("Cash to collect", "cash")], rows: byStatus },
      ],
      sheets: [{
        name: "Delivery sheet",
        columns: [
          { header: "City", key: "city", width: 14 },
          { header: "Order", key: "order_number", width: 12 },
          { header: "Brand", key: "brand_name", width: 16 },
          { header: "Customer", key: "customer_name" },
          { header: "Phone", key: "customer_phone", width: 16 },
          { header: "Address", key: "address", width: 44 },
          { header: "Items", key: "items", width: 40 },
          numCol("Units", "units", 7),
          { header: "Courier", key: "courier", width: 14 },
          { header: "Tracking", key: "tracking", width: 18 },
          moneyCol("Cash to collect", "cash"),
          { header: "Currency", key: "currency", width: 9, money: true },
          { header: "Status", key: "status_label", width: 20 },
          { header: "Days waiting", key: "waiting", type: "days", width: 11 },
          { header: "Customer note", key: "note", width: 24 },
          { header: "Rider notes / signature", key: "rider_note", width: 26 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- K6 Delivery performance

interface OutcomeOrder {
  id: string; order_number: string; order_date: string; status: OrderStatus; status_changed_at: string; delivered_at: string | null;
  brand_id: string; city: string | null; delivery_courier: string | null; failure_reason: string | null;
  returned_due_to_discrepancy: boolean | null; brand: BrandRef;
}

const OUTCOMES: OrderStatus[] = ["delivered", "delivery_failed", "returned"];

const deliveryPerformance: ReportDef = {
  code: "K6", perm: "reports.delivery_performance", side: "kbb", category: CAT.delivery,
  title: "Delivery performance",
  description: "Delivered, failed and returned orders with success rate by city, courier and brand, and the reasons deliveries failed.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const all = await fetchAll<OutcomeOrder>((from, to) => {
      let q = table("orders").select("id, order_number, order_date, status, status_changed_at, delivered_at, brand_id, city, delivery_courier, failure_reason, returned_due_to_discrepancy, brand:organizations(name)")
        .in("status", OUTCOMES);
      q = inRange(q, "status_changed_at", f);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      return q.order("status_changed_at", { ascending: true }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading orders… ${n.toLocaleString()}`));
    // Returns caused by short receipt never went out for delivery.
    const orders = all.filter((o) => !(o.status === "returned" && o.returned_due_to_discrepancy));
    const events = await loadEvents(orders.map((o) => o.id), ctx.progress);
    const fails = new Map<string, number>();
    for (const e of events) if (e.to_status === "delivery_failed") fails.set(e.order_id, (fails.get(e.order_id) ?? 0) + 1);

    const outcome = (s: OrderStatus) => (s === "delivered" ? "Delivered" : s === "delivery_failed" ? "Failed" : "Returned");
    const rows = orders.map((o) => ({
      order_number: o.order_number, order_date: o.order_date, brand_name: brandName(o.brand), city: text(o.city) || "Unknown",
      courier: text(o.delivery_courier) || "Unknown", outcome: outcome(o.status), outcome_at: o.status === "delivered" ? o.delivered_at ?? o.status_changed_at : o.status_changed_at,
      attempts_failed: fails.get(o.id) ?? 0, reason: o.failure_reason ?? "",
      days: daysBetween(o.order_date, o.status === "delivered" ? o.delivered_at ?? o.status_changed_at : o.status_changed_at),
    }));
    const perf = (name: string, header: string, key: (r: (typeof rows)[number]) => string) => ({
      name,
      columns: [{ header, key: "key" }, numCol("Orders", "orders"), numCol("Delivered", "delivered"), numCol("Failed", "failed"), numCol("Returned", "returned"), { header: "Success rate", key: "rate", type: "percent" as const }],
      rows: [...groupBy(rows, key)].map(([k, rs]) => {
        const d = rs.filter((r) => r.outcome === "Delivered").length;
        return { key: k, orders: rs.length, delivered: d, failed: rs.filter((r) => r.outcome === "Failed").length, returned: rs.filter((r) => r.outcome === "Returned").length, rate: ratio(d, rs.length) };
      }).sort((a, b) => b.orders - a.orders),
    });
    const withReason = rows.filter((r) => r.outcome !== "Delivered" || r.attempts_failed > 0);
    const reasons = [...groupBy(withReason, (r) => r.reason.trim() || "(no reason given)")].map(([k, rs]) => ({ key: k, count: rs.length }))
      .sort((a, b) => b.count - a.count);
    const delivered = rows.filter((r) => r.outcome === "Delivered");

    return {
      title: "Delivery performance",
      filters: filterLines(f, f.from || f.to ? ["Dates are when the order reached its current outcome."] : []),
      notes: [
        "Outcome is the order's current status. Orders returned because they arrived short in Bangladesh are left out.",
        "Success rate = delivered ÷ (delivered + failed + returned).",
      ],
      figures: [
        fig("Orders", rows.length),
        fig("Delivered", delivered.length),
        fig("Failed (awaiting retry or return)", rows.filter((r) => r.outcome === "Failed").length),
        fig("Returned", rows.filter((r) => r.outcome === "Returned").length),
        fig("Success rate", ratio(delivered.length, rows.length), "percent"),
        fig("Delivered on first attempt", delivered.filter((r) => r.attempts_failed === 0).length),
        fig("Median days order → delivered", median(delivered.map((r) => r.days).filter((d): d is number => d !== null)), "days"),
      ],
      breakdowns: [
        perf("By city", "City", (r) => r.city),
        perf("By courier", "Courier", (r) => r.courier),
        perf("By brand", "Brand", (r) => r.brand_name),
        { name: "Failure reasons", columns: [{ header: "Reason", key: "key", width: 40 }, numCol("Orders", "count")], rows: reasons },
      ],
      sheets: [{
        name: "Orders",
        columns: [
          { header: "Order", key: "order_number", width: 14 },
          { header: "Order date", key: "order_date", type: "datetime" },
          { header: "Brand", key: "brand_name" },
          { header: "City", key: "city", width: 16 },
          { header: "Courier", key: "courier", width: 14 },
          { header: "Outcome", key: "outcome", width: 11 },
          { header: "Outcome date", key: "outcome_at", type: "datetime" },
          numCol("Failed attempts", "attempts_failed", 13),
          { header: "Failure reason", key: "reason", width: 34 },
          { header: "Days from order", key: "days", type: "days", width: 13 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- K7 COD collection

const codCollection: ReportDef = {
  code: "K7", perm: "reports.cod_collection", side: "kbb", category: CAT.delivery, requires: ["orders.view_money"],
  title: "COD collection",
  description: "Cash expected vs collected on delivered orders, with differences by courier and brand and a list of shortfalls.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const orders = await fetchAll<OrderOverview>((from, to) => {
      let q = table("order_overview").select("*").not("delivered_at", "is", null);
      q = inRange(q, "delivered_at", f);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      return q.order("delivered_at", { ascending: true }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading delivered orders… ${n.toLocaleString()}`));
    const rows = orders.map((o) => {
      const expected = Number(o.cod_amount_expected ?? 0);
      const collected = o.cod_amount_collected === null ? null : Number(o.cod_amount_collected);
      const diff = collected === null ? null : Math.round((collected - expected) * 100) / 100;
      const state = collected === null ? (expected ? "Not recorded" : "Nothing to collect")
        : diff! < 0 ? "Short" : diff! > 0 ? "Over" : "Matched";
      return {
        order_number: o.order_number, delivered_at: o.delivered_at, brand_name: o.brand_name, customer_name: o.customer_name, city: o.city,
        courier: text(o.delivery_courier) || "Unknown", tracking: o.delivery_tracking_number ?? "", status_label: statusLabel(o.status),
        currency: o.cod_currency ?? o.currency, expected, collected, diff, state,
      };
    });
    const short = rows.filter((r) => r.state === "Short" || r.state === "Not recorded");
    const group = (name: string, header: string, key: (r: (typeof rows)[number]) => string) => ({
      name,
      columns: [{ header, key: "key" }, numCol("Orders", "orders"), moneyCol("Expected", "expected"), moneyCol("Collected", "collected"), moneyCol("Difference", "diff"), numCol("Short / not recorded", "short")],
      rows: [...groupBy(rows, key)].map(([k, rs]) => ({
        key: k, orders: rs.length, expected: sum(rs.map((r) => r.expected)), collected: sum(rs.map((r) => r.collected)),
        diff: sum(rs.map((r) => r.collected)) - sum(rs.map((r) => r.expected)), short: rs.filter((r) => r.state === "Short" || r.state === "Not recorded").length,
      })).sort((a, b) => b.expected - a.expected),
    });
    const cols: Column[] = [
      { header: "Order", key: "order_number", width: 14 },
      { header: "Delivered", key: "delivered_at", type: "datetime" },
      { header: "Brand", key: "brand_name" },
      { header: "Customer", key: "customer_name" },
      { header: "City", key: "city", width: 16 },
      { header: "Courier", key: "courier", width: 14 },
      { header: "Tracking", key: "tracking", width: 18 },
      { header: "Current status", key: "status_label", width: 18 },
      { header: "Currency", key: "currency", width: 9, money: true },
      moneyCol("Expected", "expected"),
      moneyCol("Collected", "collected"),
      moneyCol("Difference", "diff"),
      { header: "Collection", key: "state", width: 16 },
    ];
    const currencies = new Set(rows.map((r) => r.currency));

    return {
      title: "COD collection",
      filters: filterLines(f, f.from || f.to ? ["Dates are the delivery date."] : []),
      notes: [
        "Difference = collected − expected. 'Not recorded' means no collected amount was entered yet.",
        ...(currencies.size > 1 ? [`Amounts are in more than one currency (${[...currencies].join(", ")}); totals add them as-is.`] : []),
      ],
      figures: [
        fig("Delivered orders", rows.length),
        fig("Cash expected", sum(rows.map((r) => r.expected)), "money", true),
        fig("Cash collected", sum(rows.map((r) => r.collected)), "money", true),
        fig("Difference", sum(rows.map((r) => r.collected)) - sum(rows.map((r) => r.expected)), "money", true),
        fig("Short orders", rows.filter((r) => r.state === "Short").length),
        fig("Collection not recorded", rows.filter((r) => r.state === "Not recorded").length),
      ],
      breakdowns: [group("By courier", "Courier", (r) => r.courier), group("By brand", "Brand", (r) => r.brand_name)],
      sheets: [
        { name: "Delivered orders", columns: cols, rows },
        { name: "Shortfalls", columns: cols, rows: short.sort((a, b) => (a.diff ?? -a.expected) - (b.diff ?? -b.expected)) },
      ],
    };
  },
};

// ---------------------------------------------------------------- K8 Returns

interface ReturnOrder {
  id: string; order_number: string; order_date: string; status: OrderStatus; status_changed_at: string; brand_id: string;
  customer_name: string | null; customer_phone: string | null; city: string | null; delivery_courier: string | null;
  delivery_tracking_number: string | null; failure_reason: string | null; return_disposition: string | null;
  returned_due_to_discrepancy: boolean | null; order_total: number; currency: string; brand: BrandRef;
  order_items: { product_name: string; variant: string | null; sku: string | null; quantity: number; return_disposition: string | null }[];
}

const dispLabel = (d: string | null | undefined) => (d ? RETURN_DISPOSITION[d] ?? d : "");

const returnsReport: ReportDef = {
  code: "K8", perm: "reports.returns", side: "kbb", category: CAT.delivery,
  title: "Returns",
  description: "Returned and failed orders with the reason, current status and what's being done with the goods.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const orders = await fetchAll<ReturnOrder>((from, to) => {
      let q = table("orders").select("id, order_number, order_date, status, status_changed_at, brand_id, customer_name, customer_phone, city, delivery_courier, delivery_tracking_number, failure_reason, return_disposition, returned_due_to_discrepancy, order_total, currency, brand:organizations(name), order_items(product_name, variant, sku, quantity, return_disposition)")
        .in("status", ["returned", "delivery_failed"]);
      q = inRange(q, "status_changed_at", f);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      return q.order("status_changed_at", { ascending: true }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading returns… ${n.toLocaleString()}`));
    const reasonOf = (o: ReturnOrder) => (o.returned_due_to_discrepancy ? "Short on receipt in Bangladesh" : text(o.failure_reason) || "(no reason given)");
    const rows = orders.map((o) => {
      const itemDisp = [...new Set((o.order_items ?? []).map((i) => i.return_disposition).filter((d): d is string => !!d))];
      return {
        order_number: o.order_number, order_date: o.order_date, brand_name: brandName(o.brand), customer_name: o.customer_name,
        customer_phone: o.customer_phone, city: o.city, courier: o.delivery_courier ?? "", tracking: o.delivery_tracking_number ?? "",
        status_label: statusLabel(o.status), since: o.status_changed_at, reason: reasonOf(o),
        disposition: dispLabel(o.return_disposition) || itemDisp.map(dispLabel).join(", "),
        items: (o.order_items ?? []).map((i) => `${i.quantity}× ${i.product_name}${i.variant ? ` (${i.variant})` : ""}`).join("; "),
        units: sum((o.order_items ?? []).map((i) => i.quantity)), order_total: o.order_total, currency: o.currency,
      };
    });
    const itemRows = orders.flatMap((o) => (o.order_items ?? []).map((i) => ({
      order_number: o.order_number, status_label: statusLabel(o.status), brand_name: brandName(o.brand), product_name: i.product_name,
      variant: i.variant, sku: i.sku, quantity: i.quantity, disposition: dispLabel(i.return_disposition ?? o.return_disposition) || "Not decided",
    })));

    return {
      title: "Returns",
      filters: filterLines(f, f.from || f.to ? ["Dates are when the order became returned / failed."] : []),
      figures: [
        fig("Orders", rows.length),
        fig("Returned", orders.filter((o) => o.status === "returned").length),
        fig("Failed, awaiting retry or return", orders.filter((o) => o.status === "delivery_failed").length),
        fig("Returned due to short receipt", orders.filter((o) => o.returned_due_to_discrepancy).length),
        fig("Units", sum(rows.map((r) => r.units))),
        fig("Order value", sum(rows.map((r) => r.order_total)), "money", true),
      ],
      breakdowns: [
        countBreakdown("By status", "Status", rows, (r) => r.status_label),
        countBreakdown("By reason", "Reason", rows, (r) => r.reason),
        { name: "Items by disposition", columns: [{ header: "Disposition", key: "key" }, numCol("Units", "units")],
          rows: [...groupBy(itemRows, (r) => r.disposition)].map(([k, rs]) => ({ key: k, units: sum(rs.map((r) => r.quantity)) })).sort((a, b) => b.units - a.units) },
        countBreakdown("By brand", "Brand", rows, (r) => r.brand_name),
      ],
      sheets: [
        {
          name: "Orders",
          columns: [
            { header: "Order", key: "order_number", width: 14 },
            { header: "Order date", key: "order_date", type: "datetime" },
            { header: "Brand", key: "brand_name" },
            { header: "Customer", key: "customer_name" },
            { header: "Phone", key: "customer_phone", width: 16 },
            { header: "City", key: "city", width: 16 },
            { header: "Courier", key: "courier", width: 14 },
            { header: "Tracking", key: "tracking", width: 18 },
            { header: "Status", key: "status_label", width: 18 },
            { header: "Since", key: "since", type: "datetime" },
            { header: "Reason", key: "reason", width: 34 },
            { header: "Disposition", key: "disposition", width: 22 },
            { header: "Items", key: "items", width: 40 },
            numCol("Units", "units", 7),
            moneyCol("Order total", "order_total"),
            { header: "Currency", key: "currency", width: 9, money: true },
          ],
          rows,
        },
        {
          name: "Items",
          columns: [
            { header: "Order", key: "order_number", width: 14 },
            { header: "Status", key: "status_label", width: 18 },
            { header: "Brand", key: "brand_name" },
            { header: "Product", key: "product_name", width: 30 },
            { header: "Variant", key: "variant", width: 16 },
            { header: "SKU", key: "sku", width: 16 },
            numCol("Qty", "quantity", 7),
            { header: "Disposition", key: "disposition", width: 22 },
          ],
          rows: itemRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- K9 Stock report

const stockReport: ReportDef = {
  code: "K9", perm: "reports.stock", side: "kbb", category: CAT.stock,
  title: "Stock report",
  description: "Returned items restocked in Bangladesh, what's still available, and stock used to fulfil orders.",
  filters: ["brand"],
  async run(f, ctx) {
    const byBrand = <Q extends { eq: (c: string, v: string) => Q }>(q: Q) => (f.brandId ? q.eq("brand_id", f.brandId) : q);
    const restocked = await fetchAll<RestockedItem>((from, to) =>
      byBrand(table("bd_restocked_items").select("*")).order("returned_at", { ascending: true }).order("order_item_id").range(from, to),
    (n) => ctx.progress(`Loading restocked items… ${n.toLocaleString()}`));
    const dispatched = await fetchAll<DispatchedItem>((from, to) =>
      byBrand(table("bd_dispatched_items").select("*")).order("dispatched_at", { ascending: true }).order("order_item_id").range(from, to),
    (n) => ctx.progress(`Loading dispatched items… ${n.toLocaleString()}`));
    const local = await fetchAll<InventoryOrderItem>((from, to) =>
      byBrand(table("brand_inventory_usage").select("*")).order("order_date", { ascending: true }).order("order_item_id").range(from, to),
    (n) => ctx.progress(`Loading local stock orders… ${n.toLocaleString()}`));

    const restockRows = restocked.map((r) => ({ ...r, status_label: statusLabel(r.status), disposition: dispLabel(r.return_disposition), available: r.available_qty ?? r.quantity }));
    const dispatchRows = dispatched.map((r) => ({ ...r, status_label: statusLabel(r.status) }));
    const localRows = local.map((r) => ({ ...r, status_label: statusLabel(r.status) }));

    // Per product: restocked, available, dispatched, used from local brand stock.
    type P = { brand: string; product: string; variant: string; sku: string; restocked: number; available: number; dispatched: number; local: number };
    const prod = new Map<string, P>();
    const p = (brand: string, product: string, variant: string | null, sku: string | null) => {
      const k = [brand, sku || product, variant ?? ""].join("|").toLowerCase();
      let x = prod.get(k);
      if (!x) { x = { brand, product, variant: variant ?? "", sku: sku ?? "", restocked: 0, available: 0, dispatched: 0, local: 0 }; prod.set(k, x); }
      return x;
    };
    for (const r of restockRows) { const x = p(r.brand_name, r.product_name, r.variant, r.sku); x.restocked += Number(r.quantity) || 0; x.available += Number(r.available) || 0; }
    for (const r of dispatched) p(r.brand_name, r.product_name, r.variant, r.sku).dispatched += Number(r.quantity) || 0;
    for (const r of local) p(r.brand_name, r.product_name, r.variant, r.sku).local += Number(r.inventory_qty) || 0;
    const products = [...prod.values()].sort((a, b) => a.brand.localeCompare(b.brand) || a.product.localeCompare(b.product) || a.variant.localeCompare(b.variant));
    const brands = [...groupBy(products, (x) => x.brand)].map(([b, xs]) => ({
      brand: b, restocked: sum(xs.map((x) => x.restocked)), available: sum(xs.map((x) => x.available)),
      dispatched: sum(xs.map((x) => x.dispatched)), local: sum(xs.map((x) => x.local)),
    }));

    const itemCols: Column[] = [
      { header: "Brand", key: "brand_name" },
      { header: "Product", key: "product_name", width: 30 },
      { header: "Variant", key: "variant", width: 16 },
      { header: "SKU", key: "sku", width: 16 },
      { header: "Order", key: "order_number", width: 14 },
      { header: "Order status", key: "status_label", width: 18 },
      { header: "Customer", key: "customer_name" },
      { header: "City", key: "city", width: 14 },
      { header: "Shipment", key: "shipment_code", width: 12 },
    ];

    return {
      title: "Stock report",
      filters: filterLines(f),
      notes: ["Same sources as the Inventory page: restocked returns, orders dispatched from the Bangladesh warehouse, and orders fulfilled from the brand's local stock."],
      figures: [
        fig("Restocked units", sum(restockRows.map((r) => r.quantity))),
        fig("Units available now", sum(restockRows.map((r) => r.available))),
        fig("Restocked value", sum(restockRows.map((r) => r.line_total)), "money", true),
        fig("Units dispatched from BD warehouse", sum(dispatched.map((r) => r.quantity))),
        fig("Orders using local brand stock", new Set(local.map((r) => r.order_id)).size),
        fig("Units from local brand stock", sum(local.map((r) => r.inventory_qty))),
      ],
      breakdowns: [{
        name: "By brand",
        columns: [{ header: "Brand", key: "brand" }, numCol("Restocked", "restocked"), numCol("Available", "available"), numCol("Dispatched from BD", "dispatched"), numCol("Local stock used", "local")],
        rows: brands,
      }],
      sheets: [
        {
          name: "Stock by product",
          columns: [
            { header: "Brand", key: "brand" }, { header: "Product", key: "product", width: 30 }, { header: "Variant", key: "variant", width: 16 },
            { header: "SKU", key: "sku", width: 16 }, numCol("Restocked", "restocked"), numCol("Available", "available"),
            numCol("Dispatched from BD", "dispatched", 16), numCol("Local stock used", "local", 15),
          ],
          rows: products,
        },
        {
          name: "Restocked items",
          columns: [
            ...itemCols,
            { header: "Returned", key: "returned_at", type: "datetime" },
            { header: "Restocked", key: "restocked_at", type: "datetime" },
            { header: "Disposition", key: "disposition", width: 20 },
            numCol("Qty", "quantity", 7),
            numCol("Available", "available", 9),
            moneyCol("Unit price", "unit_price"),
            moneyCol("Line total", "line_total"),
            { header: "Currency", key: "currency", width: 9, money: true },
            { header: "Restock note", key: "restock_note", width: 26 },
          ],
          rows: restockRows,
        },
        {
          name: "Dispatched from BD",
          columns: [
            ...itemCols,
            { header: "Dispatched", key: "dispatched_at", type: "datetime" },
            { header: "Courier", key: "delivery_courier", width: 14 },
            { header: "Tracking", key: "delivery_tracking_number", width: 18 },
            numCol("Qty", "quantity", 7),
            moneyCol("Line total", "line_total"),
            { header: "Currency", key: "currency", width: 9, money: true },
          ],
          rows: dispatchRows,
        },
        {
          name: "Local brand stock",
          columns: [
            { header: "Brand", key: "brand_name" },
            { header: "Order", key: "order_number", width: 14 },
            { header: "Order date", key: "order_date", type: "datetime" },
            { header: "Order status", key: "status_label", width: 18 },
            { header: "Customer", key: "customer_name" },
            { header: "City", key: "city", width: 14 },
            { header: "Product", key: "product_name", width: 30 },
            { header: "Variant", key: "variant", width: 16 },
            { header: "SKU", key: "sku", width: 16 },
            numCol("Ordered", "quantity", 9),
            numCol("From local stock", "inventory_qty", 14),
          ],
          rows: localRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- K10 KBB account statement

const PAYMENT_KIND: Record<string, string> = { dispatch_advance: "Dispatch advance", delivery_balance: "Delivery balance", credit: "Credit" };
const PAYMENT_STATUS: Record<string, string> = { not_paid: "Not paid", partially_paid: "Partially paid", paid: "Paid" };
const INVOICE_TYPE: Record<string, string> = { dispatch_advance: "Dispatch advance (50%)", final_settlement: "Final settlement" };
const KBB_INVOICE_TYPES = ["dispatch_advance", "final_settlement"];

const kbbLedger: ReportDef = {
  code: "K10", perm: "reports.kbb_ledger", side: "kbb", category: CAT.stock, requires: ["money.view"],
  title: "KBB account statement",
  description: "KBB's account per shipment and order, payments made with a running balance, and KBB's own invoices.",
  filters: ["dateRange"],
  async run(f, ctx) {
    ctx.progress("Loading account…");
    const { data: accData, error: accErr } = await supabase.rpc("kbb_account_overview");
    if (accErr) throw accErr;
    const account = (accData ?? []) as KbbOrderAccount[];
    const payments = await fetchAll<KbbPayment>((from, to) =>
      table("kbb_payments").select("*, shipment:shipments(code), order:orders(order_number)").order("id").range(from, to),
    (n) => ctx.progress(`Loading payments… ${n.toLocaleString()}`));
    let invoices: InvoiceRecord[] = [];
    try {
      invoices = await fetchAll<InvoiceRecord>((from, to) => {
        let q = table("invoices").select("id, invoice_number, invoice_type, shipment_ids, order_count, total_value, advance_amount, net_remaining, payable_amount, payment_status, notes, created_at, updated_at")
          .in("invoice_type", KBB_INVOICE_TYPES);
        q = inRange(q, "created_at", f);
        return q.order("created_at", { ascending: true }).order("id").range(from, to);
      });
    } catch {
      invoices = []; // not readable for this viewer (same as the Invoices page)
    }
    invoices = invoices.filter((i) => KBB_INVOICE_TYPES.includes(i.invoice_type));

    // Dates for charges: advance at shipment dispatch, delivery balance at delivery.
    const shipIds = [...new Set(account.map((a) => a.shipment_id).filter(Boolean))];
    const dispatchedAt = new Map<string, string | null>();
    for (const ids of chunk(shipIds)) {
      const { data, error } = await table("shipment_overview").select("id, dispatched_at").in("id", ids);
      if (error) throw error;
      for (const s of (data ?? []) as Pick<ShipmentOverview, "id" | "dispatched_at">[]) dispatchedAt.set(s.id, s.dispatched_at);
    }
    const deliveredAt = new Map<string, string | null>();
    const orderIds = account.map((a) => a.order_id);
    for (const ids of chunk(orderIds)) {
      const { data, error } = await table("order_overview").select("id, delivered_at").in("id", ids);
      if (error) throw error;
      for (const o of (data ?? []) as Pick<OrderOverview, "id" | "delivered_at">[]) deliveredAt.set(o.id, o.delivered_at);
      ctx.progress(`Loading order dates… ${deliveredAt.size.toLocaleString()}`);
    }

    type Entry = { date: string; kind: string; ref: string; shipment: string; detail: string; charge: number; payment: number; balance?: number };
    const entries: Entry[] = [];
    for (const a of account) {
      const disp = dispatchedAt.get(a.shipment_id) ?? a.order_date;
      if (Number(a.advance_owed)) entries.push({ date: disp, kind: "Advance due", ref: a.order_number, shipment: a.shipment_code, detail: "50% advance at dispatch", charge: Number(a.advance_owed), payment: 0 });
      if (Number(a.delivery_owed)) entries.push({ date: deliveredAt.get(a.order_id) ?? disp, kind: "Delivery balance due", ref: a.order_number, shipment: a.shipment_code, detail: deliveredAt.get(a.order_id) ? "Delivered" : "Not delivered yet", charge: Number(a.delivery_owed), payment: 0 });
    }
    for (const p of payments) {
      entries.push({
        date: p.payment_date, kind: PAYMENT_KIND[p.kind] ?? p.kind, ref: p.order?.order_number ?? "", shipment: p.shipment?.code ?? "",
        detail: [p.currency !== "PKR" ? `${p.amount} ${p.currency}${p.fx_rate ? ` @ ${p.fx_rate}` : ""}` : "", p.note ?? ""].filter(Boolean).join(" · "),
        charge: 0, payment: Number(p.amount_pkr),
      });
    }
    entries.sort((a, b) => a.date.localeCompare(b.date) || b.charge - a.charge);
    let bal = 0;
    let opening = 0;
    const shown: Entry[] = [];
    for (const e of entries) {
      bal = Math.round((bal + e.charge - e.payment) * 100) / 100;
      e.balance = bal;
      if (f.from && e.date < f.from) { opening = bal; continue; }
      if (within(e.date, f) || (!f.from && !f.to)) shown.push(e);
    }
    const closing = shown.length ? shown[shown.length - 1].balance! : opening;
    const ledgerRows: Row[] = [
      ...(f.from ? [{ date: f.from, kind: "Opening balance", ref: "", shipment: "", detail: "", charge: null, payment: null, balance: opening }] : []),
      ...shown,
    ];

    const accRows = account
      .filter((a) => (!f.from && !f.to) || within(a.order_date, f))
      .map((a) => ({ ...a, shipment_status: SHIPMENT_STATUS_LABEL[a.shipment_status] ?? a.shipment_status, delivered_at: deliveredAt.get(a.order_id) ?? null }))
      .sort((a, b) => a.shipment_code.localeCompare(b.shipment_code) || byOrderNo(a.order_number, b.order_number));
    const byShipment = [...groupBy(accRows, (a) => a.shipment_code)].map(([code, rs]) => ({
      shipment: code, status: rs[0].shipment_status, orders: rs.length, value: sum(rs.map((r) => r.order_value_pkr)),
      advance_owed: sum(rs.map((r) => r.advance_owed)), advance_paid: sum(rs.map((r) => r.advance_paid)),
      delivery_owed: sum(rs.map((r) => r.delivery_owed)), delivery_paid: sum(rs.map((r) => r.delivery_paid)),
      credits: sum(rs.map((r) => r.credits)), net: sum(rs.map((r) => r.net_balance)),
    }));
    const payRows = payments.filter((p) => (!f.from && !f.to) || within(p.payment_date, f)).map((p) => ({
      payment_date: p.payment_date, kind: PAYMENT_KIND[p.kind] ?? p.kind, shipment: p.shipment?.code ?? "", order: p.order?.order_number ?? "",
      amount: p.amount, currency: p.currency, fx_rate: p.fx_rate, amount_pkr: p.amount_pkr, note: p.note ?? "",
    })).sort((a, b) => a.payment_date.localeCompare(b.payment_date));
    const invRows = invoices.map((i) => ({
      ...i, type: INVOICE_TYPE[i.invoice_type] ?? i.invoice_type, status: PAYMENT_STATUS[i.payment_status] ?? i.payment_status,
      shipments: (i.shipment_ids ?? []).length,
    }));

    return {
      title: "KBB account statement",
      filters: filterLines(f, ["Amounts in PKR. Positive balance = KBB still to pay."]),
      notes: [
        "Running balance = amounts due (50% advance when a shipment is dispatched, the rest when the order is delivered) − payments and credits. It can differ from the per-order net balance where a payment isn't linked to a shipment or order.",
        "Invoices lists saved dispatch-advance and final-settlement invoices only.",
        ...(f.from || f.to ? ["The per-order account is filtered by order date; payments by payment date; invoices by creation date."] : []),
      ],
      figures: [
        ...(f.from ? [fig("Opening balance", opening, "money", true)] : []),
        fig("Amounts due in period", sum(shown.map((e) => e.charge)), "money", true),
        fig("Payments & credits in period", sum(shown.map((e) => e.payment)), "money", true),
        fig("Closing balance", closing, "money", true),
        fig("Net balance, all orders (account view)", sum(account.map((a) => a.net_balance)), "money", true),
        fig("Orders with an open balance", account.filter((a) => Number(a.net_balance) !== 0).length),
        fig("Invoices not fully paid", invRows.filter((i) => i.payment_status !== "paid").length),
      ],
      breakdowns: [{
        name: "By shipment",
        columns: [
          { header: "Shipment", key: "shipment" }, { header: "Status", key: "status" }, numCol("Orders", "orders"),
          moneyCol("Order value", "value"), moneyCol("Advance owed", "advance_owed"), moneyCol("Advance paid", "advance_paid"),
          moneyCol("Delivery owed", "delivery_owed"), moneyCol("Delivery paid", "delivery_paid"), moneyCol("Credits", "credits"), moneyCol("Net balance", "net"),
        ],
        rows: byShipment,
      }],
      sheets: [
        {
          name: "Statement",
          columns: [
            { header: "Date", key: "date", type: "date" },
            { header: "Entry", key: "kind", width: 20 },
            { header: "Order", key: "ref", width: 14 },
            { header: "Shipment", key: "shipment", width: 12 },
            { header: "Detail", key: "detail", width: 30 },
            moneyCol("Due", "charge"),
            moneyCol("Paid", "payment"),
            moneyCol("Balance", "balance"),
          ],
          rows: ledgerRows,
        },
        {
          name: "Orders",
          columns: [
            { header: "Shipment", key: "shipment_code", width: 12 },
            { header: "Shipment status", key: "shipment_status", width: 18 },
            { header: "Order", key: "order_number", width: 14 },
            { header: "Order date", key: "order_date", type: "datetime" },
            { header: "Delivered", key: "delivered_at", type: "datetime" },
            moneyCol("Order value", "order_value_pkr"),
            moneyCol("Advance owed", "advance_owed"),
            moneyCol("Advance paid", "advance_paid"),
            moneyCol("Delivery owed", "delivery_owed"),
            moneyCol("Delivery paid", "delivery_paid"),
            moneyCol("Credits", "credits"),
            moneyCol("Net balance", "net_balance"),
          ],
          rows: accRows,
        },
        {
          name: "Payments",
          columns: [
            { header: "Date", key: "payment_date", type: "date" },
            { header: "Type", key: "kind", width: 18 },
            { header: "Shipment", key: "shipment", width: 12 },
            { header: "Order", key: "order", width: 14 },
            moneyCol("Amount", "amount"),
            { header: "Currency", key: "currency", width: 9, money: true },
            { header: "FX rate", key: "fx_rate", type: "number", width: 9, money: true },
            moneyCol("Amount (PKR)", "amount_pkr"),
            { header: "Note", key: "note", width: 30 },
          ],
          rows: payRows,
        },
        {
          name: "Invoices",
          columns: [
            { header: "Invoice", key: "invoice_number", width: 20 },
            { header: "Type", key: "type", width: 22 },
            { header: "Created", key: "created_at", type: "date" },
            numCol("Shipments", "shipments", 10),
            numCol("Orders", "order_count", 9),
            moneyCol("Total value", "total_value"),
            moneyCol("Advance", "advance_amount"),
            moneyCol("Net remaining", "net_remaining"),
            moneyCol("Payable", "payable_amount"),
            { header: "Payment status", key: "status", width: 15 },
            { header: "Notes", key: "notes", width: 28 },
          ],
          rows: invRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- K11 Users & access

interface RoleRowLite { id: string; organization_id: string; org_type: string; name: string; description: string | null; is_preset: boolean; role_permissions: { permission: string }[] }

const usersAccess: ReportDef = {
  code: "K11", perm: "reports.users_access", side: "kbb", category: CAT.team,
  title: "Users & access",
  description: "KBB staff with their role, and which permissions each KBB role grants.",
  filters: [],
  async run(_f, ctx) {
    ctx.progress("Loading team…");
    const members = (await fetchAll<Omit<TeamMember, "role_id">>((from, to) =>
      table("team_members").select("*").eq("organization_type", "partner").order("membership_id").range(from, to)))
      .filter((m) => m.organization_type === "partner");
    const memberships = await fetchAll<{ id: string; role_id: string | null }>((from, to) =>
      table("memberships").select("id, role_id").order("id").range(from, to));
    const roleOf = new Map(memberships.map((m) => [m.id, m.role_id]));
    const roles = (await fetchAll<RoleRowLite>((from, to) =>
      table("roles").select("id, organization_id, org_type, name, description, is_preset, role_permissions(permission)")
        .eq("org_type", "partner").order("name").order("id").range(from, to)))
      .filter((r) => r.org_type === "partner");
    const { data: permData, error: permErr } = await table("permissions").select("*").order("sort");
    if (permErr) throw permErr;
    const perms = ((permData ?? []) as PermissionDef[]).filter((p) => (p.applies_to ?? []).includes("partner"));

    const roleById = new Map(roles.map((r) => [r.id, r]));
    const rows = members.map((m) => {
      const roleId = roleOf.get(m.membership_id) ?? null;
      const role = m.role === "admin" ? "KBB admin" : (roleId && roleById.get(roleId)?.name) || "No role (no access)";
      return { full_name: m.full_name, email: m.email, phone: m.phone, organization_name: m.organization_name, role, access: m.role === "admin" ? "Full access" : roleId ? "Custom role" : "None", created_at: m.created_at };
    }).sort((a, b) => (a.full_name ?? a.email ?? "").localeCompare(b.full_name ?? b.email ?? ""));

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.role, (counts.get(r.role) ?? 0) + 1);
    const roleCols = roles.map((r, i) => ({ id: r.id, key: `r${i}`, name: r.name, set: new Set(r.role_permissions.map((p) => p.permission)) }));
    const matrix = perms.map((p) => {
      const row: Row = { area: p.area, label: p.label, key: p.key, admin: "Yes" };
      for (const c of roleCols) row[c.key] = c.set.has(p.key) ? "Yes" : "";
      return row;
    });

    return {
      title: "Users & access",
      filters: [],
      figures: [
        fig("KBB users", rows.length),
        fig("KBB admins", rows.filter((r) => r.role === "KBB admin").length),
        fig("Without a role (no access)", rows.filter((r) => r.access === "None").length),
        fig("KBB roles", roles.length),
      ],
      breakdowns: [{
        name: "Users per role",
        columns: [{ header: "Role", key: "role" }, { header: "Description", key: "description", width: 40 }, numCol("Users", "users"), numCol("Permissions", "perms")],
        rows: [
          { role: "KBB admin", description: "Every KBB permission, plus KBB's Team & access and Roles.", users: counts.get("KBB admin") ?? 0, perms: perms.length },
          ...roles.map((r) => ({ role: r.name, description: r.description ?? "", users: counts.get(r.name) ?? 0, perms: r.role_permissions.length })),
          ...(counts.get("No role (no access)") ? [{ role: "No role (no access)", description: "", users: counts.get("No role (no access)"), perms: 0 }] : []),
        ],
      }],
      sheets: [
        {
          name: "Users",
          columns: [
            { header: "Name", key: "full_name", width: 24 },
            { header: "Email", key: "email", width: 28 },
            { header: "Phone", key: "phone", width: 16 },
            { header: "Organization", key: "organization_name", width: 14 },
            { header: "Role", key: "role", width: 22 },
            { header: "Access", key: "access", width: 13 },
            { header: "Added", key: "created_at", type: "date" },
          ],
          rows,
        },
        {
          name: "Roles × permissions",
          columns: [
            { header: "Area", key: "area", width: 16 },
            { header: "Permission", key: "label", width: 34 },
            { header: "Key", key: "key", width: 26 },
            { header: "KBB admin", key: "admin", width: 11 },
            ...roleCols.map((c): Column => ({ header: c.name, key: c.key, width: Math.max(10, Math.min(24, c.name.length + 2)) })),
          ],
          rows: matrix,
        },
      ],
    };
  },
};

export const KBB_REPORTS: ReportDef[] = [
  confirmationReport, agentProductivity,
  incomingShipments, bdDiscrepancies,
  deliverySheet, deliveryPerformance, codCollection, returnsReport,
  stockReport, kbbLedger,
  usersAccess,
];
