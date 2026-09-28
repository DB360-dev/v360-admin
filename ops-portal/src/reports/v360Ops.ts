import { supabase } from "@/lib/supabase";
import type {
  InboundBatchAdmin, OrderEvent, OrderStatus, ReturnDispositionValue, ShipmentEvent, ShipmentOverview,
} from "@/lib/types";
import type { BdDiscrepancy, DispatchedItem, InventoryOrderItem, RestockedItem } from "@/hooks/useData";
import type { Column, Row, SheetSpec } from "@/lib/excel";
import type { ReportDef, ReportFilters } from "./types";
import { loadEvents, firstReached, loadOrders } from "./v360Orders";
import {
  avg, chunk, daysBetween, fetchAll, fig, filterLines, groupBy, inRange, median, ratio, statusLabel, sum,
} from "./util";

// ---------------------------------------------------------------- shared helpers

type Progress = (t: string) => void;

/** Weight from an `order_freight_weights(weight_kg)` embed (object or array). */
function weightOf(w: { weight_kg: number | null } | { weight_kg: number | null }[] | null | undefined): number | null {
  const x = Array.isArray(w) ? w[0] : w;
  return x?.weight_kg == null ? null : Number(x.weight_kg);
}

/** Name from a `brand:organizations(name)` embed. */
function nameOf(b: { name: string } | { name: string }[] | null | undefined): string {
  const x = Array.isArray(b) ? b[0] : b;
  return x?.name ?? "Unknown";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const hoursBetween = (a: string | null | undefined, b: string | null | undefined) => {
  const d = daysBetween(a, b);
  return d == null ? null : Math.round(d * 24 * 10) / 10;
};

interface ItemRow {
  id: string; order_id: string; product_name: string; sku: string | null; variant: string | null;
  quantity: number; received_quantity: number | null; unit_price: number; discount: number;
  return_disposition: ReturnDispositionValue | null; fulfilment_origin: string | null; inventory_qty: number | null;
}

interface OrderRow {
  id: string; order_number: string; order_date: string; brand_id: string; status: OrderStatus;
  customer_name: string | null; customer_phone: string | null; city: string | null;
  order_total: number; currency: string; cod_amount_expected: number | null; cod_amount_collected: number | null; cod_currency: string | null;
  confirmation_attempts: number; confirmed_at: string | null;
  inbound_batch_id: string | null; received_at_hub_at: string | null; hub_notes: string | null;
  shipment_id: string | null; delivery_courier: string | null; delivery_tracking_number: string | null;
  delivered_at: string | null; failure_reason: string | null; return_disposition: string | null;
  returned_due_to_discrepancy?: boolean; status_changed_at: string;
  brand: { name: string } | { name: string }[] | null;
  order_items: ItemRow[];
  order_freight_weights: { weight_kg: number | null } | { weight_kg: number | null }[] | null;
  inbound_batch: { dispatch_date: string; courier: string; tracking_number: string | null } | null;
}

const ORDER_SELECT =
  "id, order_number, order_date, brand_id, status, status_changed_at, customer_name, customer_phone, city, order_total, currency, " +
  "cod_amount_expected, cod_amount_collected, cod_currency, confirmation_attempts, confirmed_at, inbound_batch_id, received_at_hub_at, " +
  "hub_notes, shipment_id, delivery_courier, delivery_tracking_number, delivered_at, failure_reason, return_disposition, returned_due_to_discrepancy, " +
  "brand:organizations(name), order_items(*), order_freight_weights(weight_kg), inbound_batch:inbound_batches(dispatch_date, courier, tracking_number)";

/** Orders (with items, weight, brand and inbound parcel) whose `dateColumn` is in the range (and not null). */
async function loadOrderRows(dateColumn: string, f: ReportFilters, progress: Progress): Promise<OrderRow[]> {
  return fetchAll<OrderRow>((from, to) => {
    let q = inRange(baseOrders(), dateColumn, f).not(dateColumn, "is", null);
    if (f.brandId) q = q.eq("brand_id", f.brandId);
    return q.order("order_date", { ascending: true }).order("id").range(from, to);
  }, (n) => progress(`Loading orders… ${n.toLocaleString()}`));
}
// Cast keeps supabase-js from parsing the long select string (rows are typed as OrderRow).
const baseOrders = () => supabase.from("orders").select(ORDER_SELECT as "*");

/** Same as loadOrderRows but for a list of ids (chunked). */
async function loadOrderRowsByIds(ids: string[], f: ReportFilters, progress: Progress): Promise<OrderRow[]> {
  const out: OrderRow[] = [];
  for (const c of chunk([...new Set(ids)])) {
    const rows = await fetchAll<OrderRow>((from, to) => {
      let q = baseOrders().in("id", c);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      return q.order("order_date", { ascending: true }).order("id").range(from, to);
    });
    out.push(...rows);
    progress(`Loading orders… ${out.length.toLocaleString()}`);
  }
  return out.sort((a, b) => a.order_date.localeCompare(b.order_date) || a.id.localeCompare(b.id));
}

/** Status events in the date range reaching any of `statuses`. */
async function eventsTo(statuses: OrderStatus[], f: ReportFilters, progress: Progress): Promise<OrderEvent[]> {
  return fetchAll<OrderEvent>((from, to) => {
    let q = supabase.from("order_events").select("id, order_id, actor_label, action, from_status, to_status, note, created_at").in("to_status", statuses);
    q = inRange(q, "created_at", f);
    return q.order("id").range(from, to);
  }, (n) => progress(`Loading order history… ${n.toLocaleString()}`));
}

const units = (items: ItemRow[]) => sum(items.map((i) => i.quantity));
const receivedUnits = (items: ItemRow[]) => sum(items.map((i) => i.received_quantity));
const itemLabel = (i: { product_name: string; variant: string | null }) => (i.variant ? `${i.product_name} · ${i.variant}` : i.product_name);

const col = {
  order: { header: "Order", key: "order_number", width: 14 } as Column,
  brand: { header: "Brand", key: "brand_name" } as Column,
  n: (header: string, key: string, width = 12): Column => ({ header, key, type: "number", width }),
  kg: (header: string, key: string): Column => ({ header, key, type: "days", width: 11 }),
  money: (header: string, key: string): Column => ({ header, key, type: "money", money: true }),
};

/** A breakdown sheet sorted by its first number column. */
const breakdown = (name: string, columns: Column[], rows: Row[], sortKey?: string): SheetSpec => ({
  name, columns,
  rows: sortKey ? [...rows].sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0)) : rows,
});

// ---------------------------------------------------------------- V8 Dispatches to the hub

const brandDispatches: ReportDef = {
  code: "V8", perm: "reports.brand_dispatches", side: "v360", category: "Hub",
  title: "Dispatches to the hub",
  description: "Parcels brands sent to the Lahore hub: courier, tracking, status and how many orders were received.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const batches = await fetchAll<InboundBatchAdmin>((from, to) => {
      let q = supabase.from("inbound_batch_overview").select("*");
      q = inRange(q, "dispatch_date", f);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      return q.order("dispatch_date", { ascending: true }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading parcels… ${n.toLocaleString()}`));
    const rows = batches.map((b) => ({
      ...b, status_label: b.status === "in_transit" ? "In transit" : b.status === "received" ? "Received" : b.status === "issue" ? "Issue" : b.status,
      days_to_receive: daysBetween(b.dispatch_date, b.received_at),
    }));
    const agg = (bs: InboundBatchAdmin[]) => ({
      parcels: bs.length, orders: sum(bs.map((b) => b.order_count)), received: sum(bs.map((b) => b.received_count)),
      awaiting: sum(bs.map((b) => b.awaiting_count)), issues: sum(bs.map((b) => b.issue_count)),
      avg_days: avg(bs.map((b) => daysBetween(b.dispatch_date, b.received_at)).filter((d): d is number => d != null)),
    });
    const aggCols: Column[] = [
      col.n("Parcels", "parcels"), col.n("Orders", "orders"), col.n("Received", "received"), col.n("Awaiting", "awaiting"),
      col.n("Issues", "issues"), { header: "Avg days to receive", key: "avg_days", type: "days" },
    ];
    const total = agg(batches);
    return {
      title: "Dispatches to the hub",
      filters: filterLines(f, ["Dates are the brand's dispatch date"]),
      figures: [
        fig("Parcels", total.parcels), fig("Orders", total.orders), fig("Orders received", total.received),
        fig("Orders awaiting", total.awaiting), fig("Orders with issues", total.issues),
        fig("Parcels still in transit", batches.filter((b) => b.status === "in_transit").length),
        fig("Avg days to receive", total.avg_days, "days"),
      ],
      breakdowns: [
        breakdown("By brand", [{ header: "Brand", key: "key" }, ...aggCols], [...groupBy(batches, (b) => b.brand_name ?? "Unknown")].map(([k, bs]) => ({ key: k, ...agg(bs) })), "parcels"),
        breakdown("By courier", [{ header: "Courier", key: "key" }, ...aggCols], [...groupBy(batches, (b) => b.courier || "Unknown")].map(([k, bs]) => ({ key: k, ...agg(bs) })), "parcels"),
      ],
      sheets: [{
        name: "Parcels",
        columns: [
          col.brand, { header: "Courier", key: "courier", width: 16 }, { header: "Tracking", key: "tracking_number", width: 18 },
          { header: "Dispatch date", key: "dispatch_date", type: "date" }, { header: "Status", key: "status_label", width: 12 },
          { header: "Courier status", key: "courier_status", width: 18 },
          col.n("Orders", "order_count", 9), col.n("Received", "received_count", 10), col.n("Awaiting", "awaiting_count", 10), col.n("Issues", "issue_count", 9),
          { header: "Received at", key: "received_at", type: "datetime" }, { header: "Days to receive", key: "days_to_receive", type: "days" },
          { header: "Notes", key: "notes", width: 30 }, { header: "Created", key: "created_at", type: "datetime" },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V9 Hub receiving

const hubReceiving: ReportDef = {
  code: "V9", perm: "reports.hub_receiving", side: "v360", category: "Hub",
  title: "Hub receiving",
  description: "Orders received at the hub: units ordered vs received, parcel weight, hub notes and days from brand dispatch to receipt.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const orders = await loadOrderRows("received_at_hub_at", f, ctx.progress);
    const rows = orders.map((o) => {
      const ordered = units(o.order_items), received = receivedUnits(o.order_items);
      return {
        order_number: o.order_number, order_date: o.order_date, brand_name: nameOf(o.brand), status_label: statusLabel(o.status),
        courier: o.inbound_batch?.courier ?? null, tracking: o.inbound_batch?.tracking_number ?? null,
        dispatch_date: o.inbound_batch?.dispatch_date ?? null, received_at_hub_at: o.received_at_hub_at,
        days: daysBetween(o.inbound_batch?.dispatch_date, o.received_at_hub_at),
        items: o.order_items.length, ordered, received, short: Math.max(0, ordered - received),
        weight: weightOf(o.order_freight_weights), hub_notes: o.hub_notes,
      };
    });
    const agg = (rs: typeof rows) => ({
      orders: rs.length, ordered: sum(rs.map((r) => r.ordered)), received: sum(rs.map((r) => r.received)),
      short: sum(rs.map((r) => r.short)), kg: round2(sum(rs.map((r) => r.weight))),
      avg_days: avg(rs.map((r) => r.days).filter((d): d is number => d != null)),
    });
    const t = agg(rows);
    return {
      title: "Hub receiving",
      filters: filterLines(f, ["Dates are when the order was received at the hub"]),
      figures: [
        fig("Orders received", t.orders), fig("Units ordered", t.ordered), fig("Units received", t.received),
        fig("Units short", t.short), fig("Orders with short units", rows.filter((r) => r.short > 0).length),
        fig("Total weight (kg)", t.kg, "days"), fig("Avg days dispatch → receipt", t.avg_days, "days"),
      ],
      breakdowns: [breakdown("By brand", [
        { header: "Brand", key: "brand" }, col.n("Orders", "orders"), col.n("Units ordered", "ordered"), col.n("Units received", "received"),
        col.n("Units short", "short"), col.kg("Weight (kg)", "kg"), { header: "Avg days", key: "avg_days", type: "days" },
      ], [...groupBy(rows, (r) => r.brand_name)].map(([b, rs]) => ({ brand: b, ...agg(rs) })), "orders")],
      sheets: [{
        name: "Received orders",
        columns: [
          col.order, { header: "Order date", key: "order_date", type: "datetime" }, col.brand, { header: "Current status", key: "status_label", width: 20 },
          { header: "Courier", key: "courier", width: 14 }, { header: "Tracking", key: "tracking", width: 18 },
          { header: "Dispatched", key: "dispatch_date", type: "date" }, { header: "Received at hub", key: "received_at_hub_at", type: "datetime" },
          { header: "Days to receive", key: "days", type: "days" },
          col.n("Lines", "items", 8), col.n("Units ordered", "ordered"), col.n("Units received", "received"), col.n("Short", "short", 8),
          col.kg("Weight (kg)", "weight"), { header: "Hub notes", key: "hub_notes", width: 34 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V10 Hub issues / short receipts

const hubIssues: ReportDef = {
  code: "V10", perm: "reports.hub_issues", side: "v360", category: "Hub",
  title: "Hub issues and short receipts",
  description: "Orders flagged as a hub issue and items received at the hub in smaller quantity than ordered.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const issueEvents = await eventsTo(["hub_issue"], f, ctx.progress);
    const received = await loadOrderRows("received_at_hub_at", f, ctx.progress);
    const flaggedIds = new Set(issueEvents.map((e) => e.order_id));
    const known = new Set(received.map((o) => o.id));
    const extra = await loadOrderRowsByIds([...flaggedIds].filter((id) => !known.has(id)), f, ctx.progress);
    const orders = [...received, ...extra];
    const eventsByOrder = groupBy(issueEvents, (e) => e.order_id);

    const rows: Row[] = [];
    const orderSummaries: { brand: string; flagged: boolean; shortLines: number; shortUnits: number }[] = [];
    for (const o of orders) {
      const evs = (eventsByOrder.get(o.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const flagged = evs.length > 0 || o.status === "hub_issue";
      const shortItems = o.order_items.filter((i) => (i.received_quantity ?? 0) < i.quantity);
      // Items only count as short once the order has been received at the hub.
      const shorts = o.received_at_hub_at ? shortItems : [];
      if (!flagged && !shorts.length) continue;
      const base = {
        order_number: o.order_number, brand_name: nameOf(o.brand), status_label: statusLabel(o.status),
        received_at_hub_at: o.received_at_hub_at, flagged_at: evs[0]?.created_at ?? null, hub_issue: flagged ? "Yes" : "No",
        note: [o.hub_notes, ...evs.map((e) => e.note)].filter(Boolean).join(" | ") || null,
      };
      if (shorts.length) {
        for (const i of shorts) rows.push({
          ...base, item: itemLabel(i), sku: i.sku, ordered: i.quantity, received: i.received_quantity ?? 0,
          short: i.quantity - (i.received_quantity ?? 0),
        });
      } else rows.push({ ...base, item: null, sku: null, ordered: units(o.order_items), received: receivedUnits(o.order_items), short: null });
      orderSummaries.push({ brand: base.brand_name, flagged, shortLines: shorts.length, shortUnits: sum(shorts.map((i) => i.quantity - (i.received_quantity ?? 0))) });
    }
    const agg = (xs: typeof orderSummaries) => ({
      orders: xs.length, flagged: xs.filter((x) => x.flagged).length, short_orders: xs.filter((x) => x.shortLines > 0).length,
      short_lines: sum(xs.map((x) => x.shortLines)), short_units: sum(xs.map((x) => x.shortUnits)),
    });
    const t = agg(orderSummaries);
    return {
      title: "Hub issues and short receipts",
      filters: filterLines(f, ["Includes orders flagged as a hub issue in the range, and orders received at the hub in the range with short items"]),
      figures: [
        fig("Orders with an issue", t.orders), fig("Flagged as hub issue", t.flagged), fig("Orders with short items", t.short_orders),
        fig("Short item lines", t.short_lines), fig("Short units", t.short_units),
        fig("Currently in hub issue", orders.filter((o) => o.status === "hub_issue").length),
      ],
      breakdowns: [breakdown("By brand", [
        { header: "Brand", key: "brand" }, col.n("Orders", "orders"), col.n("Flagged hub issue", "flagged"), col.n("Orders short", "short_orders"),
        col.n("Short lines", "short_lines"), col.n("Short units", "short_units"),
      ], [...groupBy(orderSummaries, (x) => x.brand)].map(([b, xs]) => ({ brand: b, ...agg(xs) })), "orders")],
      sheets: [{
        name: "Issues",
        columns: [
          col.order, col.brand, { header: "Item", key: "item", width: 30 }, { header: "SKU", key: "sku", width: 16 },
          col.n("Ordered", "ordered", 9), col.n("Received", "received", 9), col.n("Short by", "short", 9),
          { header: "Hub issue flagged", key: "hub_issue", width: 10 }, { header: "Flagged at", key: "flagged_at", type: "datetime" },
          { header: "Received at hub", key: "received_at_hub_at", type: "datetime" }, { header: "Current status", key: "status_label", width: 20 },
          { header: "Note", key: "note", width: 40 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- shipments

const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  draft: "Draft", ready_for_dispatch: "Ready for dispatch", handed_to_carrier: "Handed to carrier", in_transit: "In transit",
  customs: "Customs", arrived_bd: "Arrived BD", received_by_partner: "Received by KBB",
};
const shipStatus = (s: string | null | undefined) => (s ? SHIPMENT_STATUS_LABEL[s] ?? s : "");

async function loadShipments(f: ReportFilters, column: string, progress: Progress): Promise<ShipmentOverview[]> {
  return fetchAll<ShipmentOverview>((from, to) => {
    let q = supabase.from("shipment_overview").select("*");
    q = inRange(q, column, f);
    if (column !== "created_at") q = q.not(column, "is", null);
    return q.order("created_at", { ascending: true }).order("id").range(from, to);
  }, (n) => progress(`Loading shipments… ${n.toLocaleString()}`));
}

/** shipment id → brand names on it. */
async function shipmentBrands(ids: string[], progress: Progress): Promise<Map<string, string[]>> {
  const m = new Map<string, Set<string>>();
  for (const c of chunk(ids)) {
    const rows = await fetchAll<{ id: string; shipment_id: string; brand: { name: string } | { name: string }[] | null }>((from, to) =>
      supabase.from("orders").select("id, shipment_id, brand:organizations(name)").in("shipment_id", c).order("id").range(from, to));
    for (const r of rows) {
      const s = m.get(r.shipment_id) ?? new Set<string>();
      s.add(nameOf(r.brand));
      m.set(r.shipment_id, s);
    }
    progress("Loading shipment brands…");
  }
  return new Map([...m].map(([k, v]) => [k, [...v].sort()]));
}

async function loadShipmentEvents(ids: string[]): Promise<ShipmentEvent[]> {
  const out: ShipmentEvent[] = [];
  for (const c of chunk(ids)) {
    out.push(...await fetchAll<ShipmentEvent>((from, to) =>
      supabase.from("shipment_events").select("*").in("shipment_id", c).order("id").range(from, to)));
  }
  return out;
}

// ---------------------------------------------------------------- V11 Shipment register

const shipmentRegister: ReportDef = {
  code: "V11", perm: "reports.shipment_register", side: "v360", category: "Shipments",
  title: "Shipment register",
  description: "Every shipment to Bangladesh: carrier, tracking, status, orders, brands, weight, COD expected and transit time.",
  filters: ["dateRange"],
  async run(f, ctx) {
    const ships = await loadShipments(f, "created_at", ctx.progress);
    const brands = await shipmentBrands(ships.map((s) => s.id), ctx.progress);
    const rows = ships.map((s) => ({
      ...s, status_label: shipStatus(s.status), brands: (brands.get(s.id) ?? []).join(", "),
      transit_days: daysBetween(s.dispatched_at, s.received_at),
    }));
    const agg = (xs: typeof rows) => ({
      shipments: xs.length, orders: sum(xs.map((s) => s.order_count)), kg: round2(sum(xs.map((s) => s.total_weight_kg))),
      cod: sum(xs.map((s) => s.cod_expected)),
      avg_days: avg(xs.map((s) => s.transit_days).filter((d): d is number => d != null)),
    });
    const aggCols: Column[] = [
      col.n("Shipments", "shipments"), col.n("Orders", "orders"), col.kg("Weight (kg)", "kg"), col.money("COD expected", "cod"),
      { header: "Avg days", key: "avg_days", type: "days" },
    ];
    const t = agg(rows);
    return {
      title: "Shipment register",
      filters: filterLines(f, ["Dates are when the shipment was created"]),
      figures: [
        fig("Shipments", t.shipments), fig("Orders", t.orders), fig("Total weight (kg)", t.kg, "days"),
        fig("COD expected", t.cod, "money", true), fig("Received by KBB", rows.filter((s) => s.status === "received_by_partner").length),
        fig("Avg days dispatched → received", t.avg_days, "days"),
      ],
      breakdowns: [
        breakdown("By carrier", [{ header: "Carrier", key: "key" }, ...aggCols], [...groupBy(rows, (s) => s.shipping_partner || "Unknown")].map(([k, xs]) => ({ key: k, ...agg(xs) })), "shipments"),
        breakdown("By status", [{ header: "Status", key: "key" }, ...aggCols], [...groupBy(rows, (s) => s.status_label)].map(([k, xs]) => ({ key: k, ...agg(xs) })), "shipments"),
      ],
      sheets: [{
        name: "Shipments",
        columns: [
          { header: "Code", key: "code", width: 12 }, { header: "Carrier", key: "shipping_partner", width: 16 }, { header: "Tracking", key: "tracking_number", width: 18 },
          { header: "Status", key: "status_label", width: 18 }, { header: "Origin", key: "origin", width: 12 }, { header: "Destination", key: "destination", width: 12 },
          col.n("Orders", "order_count", 9), col.n("Brands", "brand_count", 9), { header: "Brand names", key: "brands", width: 30 },
          col.kg("Weight (kg)", "total_weight_kg"), col.money("COD expected", "cod_expected"),
          { header: "Created", key: "created_at", type: "datetime" }, { header: "Dispatched", key: "dispatched_at", type: "datetime" },
          { header: "Received by KBB", key: "received_at", type: "datetime" }, { header: "Days in transit", key: "transit_days", type: "days" },
          { header: "Notes", key: "notes", width: 30 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V12 Shipment manifest

const shipmentManifest: ReportDef = {
  code: "V12", perm: "reports.shipment_manifest", side: "v360", category: "Shipments",
  title: "Shipment manifest",
  description: "One shipment's orders and items: customer, city, weight, COD, and hub vs Bangladesh stock quantities.",
  filters: ["shipment"],
  required: ["shipment"],
  async run(f, ctx) {
    if (!f.shipmentId) throw new Error("Choose a shipment");
    const { data: ship, error } = await supabase.from("shipment_overview").select("*").eq("id", f.shipmentId).maybeSingle();
    if (error) throw error;
    const s = ship as ShipmentOverview | null;
    const orders = await fetchAll<OrderRow>((from, to) =>
      baseOrders().eq("shipment_id", f.shipmentId!).order("order_number").order("id").range(from, to),
    (n) => ctx.progress(`Loading orders… ${n.toLocaleString()}`));
    const bdRecv = await fetchAll<{ order_item_id: string; received_qty: number; expected_qty: number }>((from, to) =>
      supabase.from("bd_received_items").select("*").eq("shipment_id", f.shipmentId!).order("id").range(from, to));
    const bdByItem = new Map(bdRecv.map((r) => [r.order_item_id, r]));

    const orderRows = orders.map((o) => ({
      order_number: o.order_number, brand_name: nameOf(o.brand), customer_name: o.customer_name, customer_phone: o.customer_phone,
      city: o.city, status_label: statusLabel(o.status), lines: o.order_items.length, units: units(o.order_items),
      hub_units: receivedUnits(o.order_items), bd_stock_units: sum(o.order_items.map((i) => i.inventory_qty)),
      weight: weightOf(o.order_freight_weights), cod: o.cod_amount_expected, cod_currency: o.cod_currency ?? o.currency,
    }));
    const itemRows = orders.flatMap((o) => o.order_items.map((i) => {
      const bd = bdByItem.get(i.id);
      return {
        order_number: o.order_number, brand_name: nameOf(o.brand), product_name: i.product_name, sku: i.sku, variant: i.variant,
        quantity: i.quantity, hub_qty: i.received_quantity, bd_stock_qty: i.inventory_qty ?? 0,
        origin: i.fulfilment_origin === "bangladesh" ? "Bangladesh stock" : i.fulfilment_origin === "pakistan" ? "Pakistan" : i.fulfilment_origin,
        bd_received: bd?.received_qty ?? null,
      };
    }));
    const agg = (rs: typeof orderRows) => ({
      orders: rs.length, units: sum(rs.map((r) => r.units)), kg: round2(sum(rs.map((r) => r.weight))), cod: sum(rs.map((r) => r.cod)),
    });
    const t = agg(orderRows);
    return {
      title: `Shipment manifest ${s?.code ?? f.shipmentCode ?? ""}`.trim(),
      filters: [
        `Shipment: ${s?.code ?? f.shipmentCode ?? f.shipmentId}`,
        ...(s ? [`Carrier: ${s.shipping_partner ?? "—"}  Tracking: ${s.tracking_number ?? "—"}  Status: ${shipStatus(s.status)}`] : []),
        ...(s?.dispatched_at ? [`Dispatched: ${new Date(s.dispatched_at).toLocaleString()}`] : []),
      ],
      figures: [
        fig("Orders", t.orders), fig("Units", t.units), fig("Weight (kg)", t.kg, "days"),
        fig("COD expected", t.cod, "money", true), fig("Brands", new Set(orderRows.map((r) => r.brand_name)).size),
      ],
      breakdowns: [breakdown("By brand", [
        { header: "Brand", key: "brand" }, col.n("Orders", "orders"), col.n("Units", "units"), col.kg("Weight (kg)", "kg"), col.money("COD expected", "cod"),
      ], [...groupBy(orderRows, (r) => r.brand_name)].map(([b, rs]) => ({ brand: b, ...agg(rs) })), "orders")],
      sheets: [
        {
          name: "Orders",
          columns: [
            col.order, col.brand, { header: "Customer", key: "customer_name" }, { header: "Phone", key: "customer_phone", width: 16 },
            { header: "City", key: "city", width: 16 }, { header: "Status", key: "status_label", width: 20 },
            col.n("Lines", "lines", 8), col.n("Units", "units", 8), col.n("Hub units", "hub_units", 10), col.n("BD stock units", "bd_stock_units", 10),
            col.kg("Weight (kg)", "weight"), col.money("COD expected", "cod"), { header: "COD currency", key: "cod_currency", width: 9, money: true },
          ],
          rows: orderRows,
        },
        {
          name: "Items",
          columns: [
            col.order, col.brand, { header: "Product", key: "product_name", width: 30 }, { header: "SKU", key: "sku", width: 16 },
            { header: "Variant", key: "variant", width: 16 }, col.n("Qty", "quantity", 8), col.n("Received at hub", "hub_qty", 10),
            col.n("From BD stock", "bd_stock_qty", 10), { header: "Fulfilled from", key: "origin", width: 16 },
            col.n("Received by KBB", "bd_received", 10),
          ],
          rows: itemRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- V13 Transit performance

const transitPerformance: ReportDef = {
  code: "V13", perm: "reports.transit_performance", side: "v360", category: "Shipments",
  title: "Transit performance",
  description: "Days from dispatch to arrival in Bangladesh and to KBB receipt, per shipment and per carrier.",
  filters: ["dateRange"],
  async run(f, ctx) {
    const ships = await loadShipments(f, "dispatched_at", ctx.progress);
    ctx.progress("Loading shipment history…");
    const events = await loadShipmentEvents(ships.map((s) => s.id));
    const arrived = new Map<string, string>();
    for (const e of events) {
      if (e.to_status !== "arrived_bd") continue;
      const cur = arrived.get(e.shipment_id);
      if (!cur || e.created_at < cur) arrived.set(e.shipment_id, e.created_at);
    }
    const rows = ships.map((s) => ({
      ...s, status_label: shipStatus(s.status), arrived_bd_at: arrived.get(s.id) ?? null,
      to_arrival: daysBetween(s.dispatched_at, arrived.get(s.id)), to_received: daysBetween(s.dispatched_at, s.received_at),
    }));
    const nums = (xs: (number | null)[]) => xs.filter((d): d is number => d != null);
    const agg = (xs: typeof rows) => {
      const r = nums(xs.map((x) => x.to_received)), a = nums(xs.map((x) => x.to_arrival));
      return {
        shipments: xs.length, completed: r.length, avg: avg(r), median: median(r), max: r.length ? Math.max(...r) : null,
        avg_arrival: avg(a), median_arrival: median(a),
      };
    };
    const t = agg(rows);
    return {
      title: "Transit performance",
      filters: filterLines(f, ["Dates are when the shipment was dispatched", "Arrived BD is the first time the shipment was marked Arrived BD"]),
      figures: [
        fig("Shipments dispatched", t.shipments), fig("Received by KBB", t.completed),
        fig("Avg days to KBB receipt", t.avg, "days"), fig("Median days to KBB receipt", t.median, "days"), fig("Longest (days)", t.max, "days"),
        fig("Avg days to arrive BD", t.avg_arrival, "days"),
      ],
      breakdowns: [breakdown("By carrier", [
        { header: "Carrier", key: "carrier" }, col.n("Shipments", "shipments"), col.n("Received", "completed"),
        { header: "Avg days", key: "avg", type: "days" }, { header: "Median days", key: "median", type: "days" }, { header: "Max days", key: "max", type: "days" },
        { header: "Avg days to arrive BD", key: "avg_arrival", type: "days" }, { header: "Median to arrive BD", key: "median_arrival", type: "days" },
      ], [...groupBy(rows, (s) => s.shipping_partner || "Unknown")].map(([c, xs]) => ({ carrier: c, ...agg(xs) })), "shipments")],
      sheets: [{
        name: "Shipments",
        columns: [
          { header: "Code", key: "code", width: 12 }, { header: "Carrier", key: "shipping_partner", width: 16 }, { header: "Tracking", key: "tracking_number", width: 18 },
          { header: "Status", key: "status_label", width: 18 }, col.n("Orders", "order_count", 9), col.kg("Weight (kg)", "total_weight_kg"),
          { header: "Dispatched", key: "dispatched_at", type: "datetime" }, { header: "Arrived BD", key: "arrived_bd_at", type: "datetime" },
          { header: "Received by KBB", key: "received_at", type: "datetime" },
          { header: "Days to arrive BD", key: "to_arrival", type: "days" }, { header: "Days to KBB receipt", key: "to_received", type: "days" },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V14 Confirmations

const confirmations: ReportDef = {
  code: "V14", perm: "reports.confirmations", side: "v360", category: "Bangladesh",
  title: "Confirmation report",
  description: "Customer confirmation outcome per order: attempts, time to confirm, cancelled, unreachable or pending.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const orders = await loadOrderRows("order_date", f, ctx.progress);
    const reached = firstReached(await loadEvents(orders.map((o) => o.id), ctx.progress));
    const outcome = (o: OrderRow): string => {
      if (o.confirmed_at) return "Confirmed";
      if (o.status === "cancelled") return "Cancelled";
      if (o.status === "customer_unreachable") return "Unreachable";
      if (o.status === "needs_amendment") return "Needs amendment";
      return "Pending";
    };
    const rows = orders.map((o) => {
      const r = reached.get(o.id) ?? {};
      return {
        order_number: o.order_number, order_date: o.order_date, brand_name: nameOf(o.brand), customer_name: o.customer_name,
        customer_phone: o.customer_phone, city: o.city, attempts: o.confirmation_attempts ?? 0, confirmed_at: o.confirmed_at,
        hours: hoursBetween(o.order_date, o.confirmed_at), outcome: outcome(o), status_label: statusLabel(o.status),
        was_unreachable: r.customer_unreachable ? "Yes" : "No", cancelled_at: r.cancelled ?? null,
      };
    });
    const agg = (xs: typeof rows) => {
      const n = xs.length, c = (k: string) => xs.filter((x) => x.outcome === k).length;
      return {
        orders: n, confirmed: c("Confirmed"), confirmed_pct: ratio(c("Confirmed"), n), cancelled_pct: ratio(c("Cancelled"), n),
        unreachable_pct: ratio(c("Unreachable"), n), pending: c("Pending") + c("Needs amendment"),
        avg_attempts: avg(xs.map((x) => x.attempts)),
        median_hours: median(xs.map((x) => x.hours).filter((h): h is number => h != null)),
      };
    };
    const t = agg(rows);
    const byOutcome = [...groupBy(rows, (r) => r.outcome)].map(([k, xs]) => ({ outcome: k, orders: xs.length, share: ratio(xs.length, rows.length) }));
    return {
      title: "Confirmation report",
      filters: filterLines(f, ["Dates are the order date"]),
      figures: [
        fig("Orders", t.orders), fig("Confirmed", t.confirmed), fig("Confirmed %", t.confirmed_pct, "percent"),
        fig("Cancelled %", t.cancelled_pct, "percent"), fig("Unreachable %", t.unreachable_pct, "percent"),
        fig("Pending / needs amendment", t.pending), fig("Avg attempts", t.avg_attempts, "days"),
        fig("Median hours to confirm", t.median_hours, "days"),
      ],
      breakdowns: [
        breakdown("By outcome", [{ header: "Outcome", key: "outcome" }, col.n("Orders", "orders"), { header: "Share", key: "share", type: "percent" }], byOutcome, "orders"),
        breakdown("By brand", [
          { header: "Brand", key: "brand" }, col.n("Orders", "orders"), { header: "Confirmed %", key: "confirmed_pct", type: "percent" },
          { header: "Cancelled %", key: "cancelled_pct", type: "percent" }, { header: "Unreachable %", key: "unreachable_pct", type: "percent" },
          { header: "Avg attempts", key: "avg_attempts", type: "days" }, { header: "Median hours to confirm", key: "median_hours", type: "days" },
        ], [...groupBy(rows, (r) => r.brand_name)].map(([b, xs]) => ({ brand: b, ...agg(xs) })), "orders"),
      ],
      sheets: [{
        name: "Orders",
        columns: [
          col.order, { header: "Order date", key: "order_date", type: "datetime" }, col.brand, { header: "Customer", key: "customer_name" },
          { header: "Phone", key: "customer_phone", width: 16 }, { header: "City", key: "city", width: 16 },
          { header: "Outcome", key: "outcome", width: 16 }, col.n("Attempts", "attempts", 9),
          { header: "Confirmed at", key: "confirmed_at", type: "datetime" }, { header: "Hours to confirm", key: "hours", type: "days" },
          { header: "Was unreachable", key: "was_unreachable", width: 10 }, { header: "Cancelled at", key: "cancelled_at", type: "datetime" },
          { header: "Current status", key: "status_label", width: 20 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V15 Delivery performance

const DELIVERY_STAGES: OrderStatus[] = ["out_for_delivery", "delivered", "delivery_failed", "returned"];

const deliveryPerformance: ReportDef = {
  code: "V15", perm: "reports.delivery_performance", side: "v360", category: "Bangladesh",
  title: "Delivery performance",
  description: "Delivery outcomes (delivered, failed, returned), success rate and failure reasons by city, courier and brand.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const evs = await eventsTo(DELIVERY_STAGES, f, ctx.progress);
    const delivered = await loadOrderRows("delivered_at", f, ctx.progress);
    const known = new Set(delivered.map((o) => o.id));
    const orders = [...delivered, ...await loadOrderRowsByIds([...new Set(evs.map((e) => e.order_id))].filter((id) => !known.has(id)), f, ctx.progress)];
    const allEvents = await loadEvents(orders.map((o) => o.id), ctx.progress);
    const reached = firstReached(allEvents);
    const failCount = new Map<string, number>();
    for (const e of allEvents) if (e.to_status === "delivery_failed") failCount.set(e.order_id, (failCount.get(e.order_id) ?? 0) + 1);

    const outcomeOf = (o: OrderRow) =>
      o.status === "delivered" ? "Delivered" : o.status === "returned" ? "Returned" : o.status === "delivery_failed" ? "Failed" :
      o.status === "out_for_delivery" ? "Out for delivery" : statusLabel(o.status);
    const rows = orders.map((o) => {
      const r = reached.get(o.id) ?? {};
      return {
        order_number: o.order_number, order_date: o.order_date, brand_name: nameOf(o.brand), customer_name: o.customer_name, city: o.city || "Unknown",
        courier: o.delivery_courier || "Unknown", tracking: o.delivery_tracking_number, outcome: outcomeOf(o),
        out_for_delivery_at: r.out_for_delivery ?? null, delivered_at: o.delivered_at, returned_at: r.returned ?? null,
        failed_attempts: failCount.get(o.id) ?? 0, failure_reason: o.failure_reason,
        days_to_deliver: daysBetween(r.received_by_partner, o.delivered_at),
      };
    });
    const agg = (xs: typeof rows) => {
      const d = xs.filter((x) => x.outcome === "Delivered").length, fl = xs.filter((x) => x.outcome === "Failed").length;
      const rt = xs.filter((x) => x.outcome === "Returned").length;
      return {
        orders: xs.length, delivered: d, failed: fl, returned: rt, success: ratio(d, d + fl + rt),
        avg_days: avg(xs.map((x) => x.days_to_deliver).filter((n): n is number => n != null)),
      };
    };
    const aggCols: Column[] = [
      col.n("Orders", "orders"), col.n("Delivered", "delivered"), col.n("Failed", "failed"), col.n("Returned", "returned"),
      { header: "Success rate", key: "success", type: "percent" }, { header: "Avg days KBB → delivered", key: "avg_days", type: "days" },
    ];
    const by = (name: string, key: (r: (typeof rows)[number]) => string) =>
      breakdown(name, [{ header: name.replace("By ", "").replace(/^./, (c) => c.toUpperCase()), key: "key" }, ...aggCols],
        [...groupBy(rows, key)].map(([k, xs]) => ({ key: k, ...agg(xs) })), "orders");
    const reasons = [...groupBy(rows.filter((r) => r.failure_reason), (r) => r.failure_reason!.trim())]
      .map(([k, xs]) => ({ reason: k, orders: xs.length }));
    const t = agg(rows);
    return {
      title: "Delivery performance",
      filters: filterLines(f, ["Orders delivered, sent out for delivery, failed or returned in the date range"]),
      figures: [
        fig("Orders", t.orders), fig("Delivered", t.delivered), fig("Failed (current)", t.failed), fig("Returned", t.returned),
        fig("Success rate", t.success, "percent"), fig("Orders with a failed attempt", rows.filter((r) => r.failed_attempts > 0).length),
        fig("Avg days KBB receipt → delivered", t.avg_days, "days"),
      ],
      breakdowns: [
        by("By city", (r) => r.city), by("By courier", (r) => r.courier), by("By brand", (r) => r.brand_name),
        breakdown("Failure reasons", [{ header: "Reason", key: "reason", width: 40 }, col.n("Orders", "orders")], reasons, "orders"),
      ],
      sheets: [{
        name: "Deliveries",
        columns: [
          col.order, { header: "Order date", key: "order_date", type: "datetime" }, col.brand, { header: "Customer", key: "customer_name" },
          { header: "City", key: "city", width: 16 }, { header: "Courier", key: "courier", width: 14 }, { header: "Tracking", key: "tracking", width: 18 },
          { header: "Outcome", key: "outcome", width: 16 }, { header: "Out for delivery", key: "out_for_delivery_at", type: "datetime" },
          { header: "Delivered", key: "delivered_at", type: "datetime" }, { header: "Returned", key: "returned_at", type: "datetime" },
          col.n("Failed attempts", "failed_attempts", 9), { header: "Failure reason", key: "failure_reason", width: 30 },
          { header: "Days KBB → delivered", key: "days_to_deliver", type: "days" },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V16 COD collection

const codCollection: ReportDef = {
  code: "V16", perm: "reports.cod_collection", side: "v360", category: "Bangladesh",
  title: "COD collection",
  description: "Delivered orders: cash on delivery expected vs collected, with shortfalls by brand and courier.",
  filters: ["dateRange", "brand"],
  requires: ["orders.view_money"],
  async run(f, ctx) {
    const orders = (await loadOrders({ ...f, status: null }, ctx.progress, "delivered_at")).filter((o) => o.delivered_at);
    const rows = orders.map((o) => {
      const exp = Number(o.cod_amount_expected) || 0, got = Number(o.cod_amount_collected) || 0;
      return {
        order_number: o.order_number, order_date: o.order_date, brand_name: o.brand_name, customer_name: o.customer_name, city: o.city,
        courier: o.delivery_courier || "Unknown", tracking: o.delivery_tracking_number, delivered_at: o.delivered_at, status_label: statusLabel(o.status),
        expected: exp, collected: o.cod_amount_collected, difference: round2(got - exp), currency: o.cod_currency ?? o.currency,
      };
    });
    const agg = (xs: typeof rows) => ({
      orders: xs.length, expected: sum(xs.map((x) => x.expected)), collected: sum(xs.map((x) => x.collected)),
      difference: round2(sum(xs.map((x) => x.difference))), short_orders: xs.filter((x) => x.difference < 0).length,
      rate: ratio(sum(xs.map((x) => x.collected)), sum(xs.map((x) => x.expected))),
    });
    const aggCols: Column[] = [
      col.n("Orders", "orders"), col.money("Expected", "expected"), col.money("Collected", "collected"), col.money("Difference", "difference"),
      col.n("Orders short", "short_orders"), { header: "Collected %", key: "rate", type: "percent", money: true },
    ];
    const cols: Column[] = [
      col.order, { header: "Order date", key: "order_date", type: "datetime" }, col.brand, { header: "Customer", key: "customer_name" },
      { header: "City", key: "city", width: 16 }, { header: "Courier", key: "courier", width: 14 }, { header: "Tracking", key: "tracking", width: 18 },
      { header: "Delivered", key: "delivered_at", type: "datetime" }, { header: "Status", key: "status_label", width: 16 },
      col.money("COD expected", "expected"), col.money("COD collected", "collected"), col.money("Difference", "difference"),
      { header: "Currency", key: "currency", width: 9, money: true },
    ];
    const currencies = [...new Set(rows.map((r) => r.currency))];
    const t = agg(rows);
    return {
      title: "COD collection",
      filters: filterLines(f, ["Dates are the delivery date"]),
      notes: currencies.length > 1 ? [`Several currencies (${currencies.join(", ")}) — totals add amounts as recorded.`] : [],
      figures: [
        fig("Delivered orders", t.orders), fig("COD expected", t.expected, "money", true), fig("COD collected", t.collected, "money", true),
        fig("Difference", t.difference, "money", true), fig("Collected %", t.rate, "percent", true),
        fig("Orders with a shortfall", t.short_orders), fig("Orders not recorded", rows.filter((r) => r.collected == null).length),
      ],
      breakdowns: [
        breakdown("By brand", [{ header: "Brand", key: "key" }, ...aggCols], [...groupBy(rows, (r) => r.brand_name)].map(([k, xs]) => ({ key: k, ...agg(xs) })), "orders"),
        breakdown("By courier", [{ header: "Courier", key: "key" }, ...aggCols], [...groupBy(rows, (r) => r.courier)].map(([k, xs]) => ({ key: k, ...agg(xs) })), "orders"),
      ],
      sheets: [
        { name: "Delivered orders", columns: cols, rows },
        { name: "Shortfalls", columns: cols, rows: rows.filter((r) => r.difference < 0).sort((a, b) => a.difference - b.difference) },
      ],
    };
  },
};

// ---------------------------------------------------------------- V17 Returns & dispositions

const DISPOSITION_LABEL: Record<ReturnDispositionValue, string> = {
  pending: "Pending decision", restock_in_bd: "Restock in BD", return_to_pk: "Return to Pakistan",
  return_to_brand: "Return to brand", written_off: "Written off",
};
const dispLabel = (d: string | null | undefined) => (d ? DISPOSITION_LABEL[d as ReturnDispositionValue] ?? d : "Not set");

const returns: ReportDef = {
  code: "V17", perm: "reports.returns", side: "v360", category: "Bangladesh",
  title: "Returns and dispositions",
  description: "Returned orders (and cancelled orders with goods to handle) with each item's disposition.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const evs = await eventsTo(["returned", "cancelled"], f, ctx.progress);
    const whenBy = new Map<string, string>();
    for (const e of evs) { const c = whenBy.get(e.order_id); if (!c || e.created_at < c) whenBy.set(e.order_id, e.created_at); }
    const orders = (await loadOrderRowsByIds([...whenBy.keys()], f, ctx.progress)).filter((o) =>
      o.status === "returned" ||
      (o.status === "cancelled" && (o.return_disposition != null || o.order_items.some((i) => i.return_disposition != null))));
    const rows = orders.flatMap((o) => o.order_items.map((i) => ({
      order_number: o.order_number, order_date: o.order_date, brand_name: nameOf(o.brand), customer_name: o.customer_name, city: o.city,
      status_label: statusLabel(o.status), returned_at: whenBy.get(o.id) ?? null, failure_reason: o.failure_reason,
      due_to_discrepancy: o.returned_due_to_discrepancy ? "Yes" : "No",
      product_name: i.product_name, sku: i.sku, variant: i.variant, quantity: i.quantity,
      disposition: dispLabel(i.return_disposition ?? o.return_disposition),
      line_total: round2(i.quantity * Number(i.unit_price) - (Number(i.discount) || 0)), currency: o.currency,
    })));
    const aggItems = (xs: typeof rows) => ({ lines: xs.length, units: sum(xs.map((x) => x.quantity)), value: sum(xs.map((x) => x.line_total)) });
    const byBrand = [...groupBy(orders, (o) => nameOf(o.brand))].map(([b, os]) => ({
      brand: b, orders: os.length, returned: os.filter((o) => o.status === "returned").length,
      cancelled: os.filter((o) => o.status === "cancelled").length,
      discrepancy: os.filter((o) => o.returned_due_to_discrepancy).length,
      units: sum(os.map((o) => units(o.order_items))), value: sum(os.flatMap((o) => o.order_items.map((i) => i.quantity * Number(i.unit_price) - (Number(i.discount) || 0)))),
    }));
    return {
      title: "Returns and dispositions",
      filters: filterLines(f, ["Orders returned or cancelled in the date range; cancelled orders only when goods have a disposition"]),
      figures: [
        fig("Orders", orders.length), fig("Returned", orders.filter((o) => o.status === "returned").length),
        fig("Cancelled with goods", orders.filter((o) => o.status === "cancelled").length),
        fig("Returned due to discrepancy", orders.filter((o) => o.returned_due_to_discrepancy).length),
        fig("Units", sum(rows.map((r) => r.quantity))), fig("Units awaiting a decision", sum(rows.filter((r) => r.disposition === "Pending decision" || r.disposition === "Not set").map((r) => r.quantity))),
        fig("Value", sum(rows.map((r) => r.line_total)), "money", true),
      ],
      breakdowns: [
        breakdown("By disposition", [{ header: "Disposition", key: "disposition" }, col.n("Item lines", "lines"), col.n("Units", "units"), col.money("Value", "value")],
          [...groupBy(rows, (r) => r.disposition)].map(([d, xs]) => ({ disposition: d, ...aggItems(xs) })), "units"),
        breakdown("By brand", [
          { header: "Brand", key: "brand" }, col.n("Orders", "orders"), col.n("Returned", "returned"), col.n("Cancelled", "cancelled"),
          col.n("Due to discrepancy", "discrepancy"), col.n("Units", "units"), col.money("Value", "value"),
        ], byBrand, "orders"),
      ],
      sheets: [{
        name: "Returned items",
        columns: [
          col.order, { header: "Order date", key: "order_date", type: "datetime" }, col.brand, { header: "Customer", key: "customer_name" },
          { header: "City", key: "city", width: 16 }, { header: "Status", key: "status_label", width: 14 },
          { header: "Returned / cancelled", key: "returned_at", type: "datetime" }, { header: "Due to discrepancy", key: "due_to_discrepancy", width: 10 },
          { header: "Failure reason", key: "failure_reason", width: 26 },
          { header: "Product", key: "product_name", width: 30 }, { header: "SKU", key: "sku", width: 16 }, { header: "Variant", key: "variant", width: 14 },
          col.n("Qty", "quantity", 8), { header: "Disposition", key: "disposition", width: 18 },
          col.money("Line total", "line_total"), { header: "Currency", key: "currency", width: 9, money: true },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V18 BD receiving discrepancies

const bdDiscrepancies: ReportDef = {
  code: "V18", perm: "reports.bd_discrepancies", side: "v360", category: "Bangladesh",
  title: "Receiving discrepancies (Bangladesh)",
  description: "Items KBB counted differently from the shipment manifest: expected vs received, resolved or not.",
  filters: ["dateRange", "brand", "shipment"],
  async run(f, ctx) {
    const items = await fetchAll<BdDiscrepancy>((from, to) => {
      let q = supabase.from("bd_discrepancy_items").select("*");
      q = inRange(q, "checked_at", f);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      if (f.shipmentId) q = q.eq("shipment_id", f.shipmentId);
      return q.order("checked_at", { ascending: true }).order("id").range(from, to);
    }, (n) => ctx.progress(`Loading discrepancies… ${n.toLocaleString()}`));
    const rows = items.map((d) => ({
      ...d, brand_name: d.brand_name ?? "Unknown", item: itemLabel(d), short_by: Math.max(0, d.expected_qty - d.received_qty),
      over_by: Math.max(0, d.received_qty - d.expected_qty), state: d.resolved_at ? "Resolved" : "Unresolved",
      order_status_label: statusLabel(d.order_status),
    }));
    const agg = (xs: typeof rows) => ({
      lines: xs.length, orders: new Set(xs.map((x) => x.order_id)).size, expected: sum(xs.map((x) => x.expected_qty)),
      received: sum(xs.map((x) => x.received_qty)), short: sum(xs.map((x) => x.short_by)),
      unresolved: xs.filter((x) => !x.resolved_at).length,
    });
    const aggCols: Column[] = [
      col.n("Item lines", "lines"), col.n("Orders", "orders"), col.n("Expected", "expected"), col.n("Received", "received"),
      col.n("Short units", "short"), col.n("Unresolved", "unresolved"),
    ];
    const t = agg(rows);
    return {
      title: "Receiving discrepancies (Bangladesh)",
      filters: filterLines(f, ["Dates are when KBB checked the items"]),
      figures: [
        fig("Item lines", t.lines), fig("Orders affected", t.orders), fig("Units expected", t.expected), fig("Units received", t.received),
        fig("Units short", t.short), fig("Unresolved lines", t.unresolved), fig("Resolved lines", t.lines - t.unresolved),
      ],
      breakdowns: [
        breakdown("By shipment", [{ header: "Shipment", key: "key" }, ...aggCols], [...groupBy(rows, (r) => r.shipment_code ?? "Unknown")].map(([k, xs]) => ({ key: k, ...agg(xs) })), "lines"),
        breakdown("By brand", [{ header: "Brand", key: "key" }, ...aggCols], [...groupBy(rows, (r) => r.brand_name)].map(([k, xs]) => ({ key: k, ...agg(xs) })), "lines"),
      ],
      sheets: [{
        name: "Discrepancies",
        columns: [
          { header: "Shipment", key: "shipment_code", width: 12 }, col.order, col.brand, { header: "Item", key: "item", width: 30 },
          { header: "SKU", key: "sku", width: 16 }, col.n("Expected", "expected_qty", 9), col.n("Received", "received_qty", 9),
          col.n("Short by", "short_by", 9), col.n("Over by", "over_by", 9), { header: "Note", key: "note", width: 30 },
          { header: "Checked", key: "checked_at", type: "datetime" }, { header: "State", key: "state", width: 11 },
          { header: "Resolved", key: "resolved_at", type: "datetime" }, { header: "Resolved by", key: "resolved_by_name", width: 18 },
          { header: "Resolution note", key: "resolution_note", width: 30 }, { header: "Order status", key: "order_status_label", width: 18 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V19 Stock report

const stock: ReportDef = {
  code: "V19", perm: "reports.stock", side: "v360", category: "Bangladesh",
  title: "Stock report",
  description: "Bangladesh stock: restocked returned items available, items dispatched from stock and a per-SKU summary.",
  filters: ["brand"],
  async run(f, ctx) {
    const byBrand = <T>(table: string, label: string) => fetchAll<T>((from, to) => {
      let q = supabase.from(table).select("*");
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      return q.order("order_item_id").range(from, to);
    }, (n) => ctx.progress(`Loading ${label}… ${n.toLocaleString()}`));
    const restocked = await byBrand<RestockedItem>("bd_restocked_items", "restocked items");
    const dispatched = await byBrand<DispatchedItem>("bd_dispatched_items", "dispatched items");
    const local = await byBrand<InventoryOrderItem>("brand_inventory_usage", "brand stock usage");

    const restockRows = restocked.map((r) => {
      const available = r.available_qty ?? r.quantity;
      return {
        ...r, item: itemLabel(r), available, status_label: statusLabel(r.status), disposition: dispLabel(r.return_disposition),
        available_value: r.quantity ? round2((Number(r.line_total) || 0) * available / r.quantity) : 0,
      };
    });
    const dispatchRows = dispatched.map((r) => ({ ...r, item: itemLabel(r), status_label: statusLabel(r.status) }));
    const localRows = local.map((r) => ({ ...r, item: itemLabel(r), status_label: statusLabel(r.status) }));

    type Sku = { brand_name: string; sku: string | null; product_name: string; variant: string | null; restocked: number; available: number; available_value: number; dispatched: number; brand_stock_used: number };
    const skus = new Map<string, Sku>();
    const skuOf = (x: { brand_name: string; sku: string | null; product_name: string; variant: string | null }) => {
      const key = `${x.brand_name}|${x.sku ?? ""}|${x.sku ? "" : `${x.product_name}|${x.variant ?? ""}`}`;
      let s = skus.get(key);
      if (!s) { s = { brand_name: x.brand_name, sku: x.sku, product_name: x.product_name, variant: x.variant, restocked: 0, available: 0, available_value: 0, dispatched: 0, brand_stock_used: 0 }; skus.set(key, s); }
      return s;
    };
    for (const r of restockRows) { const s = skuOf(r); s.restocked += r.quantity; s.available += r.available; s.available_value += r.available_value; }
    for (const r of dispatchRows) skuOf(r).dispatched += r.quantity;
    for (const r of localRows) skuOf(r).brand_stock_used += Number(r.inventory_qty) || 0;
    const skuRows = [...skus.values()].sort((a, b) => a.brand_name.localeCompare(b.brand_name) || (a.sku ?? a.product_name).localeCompare(b.sku ?? b.product_name))
      .map((s) => ({ ...s, available_value: round2(s.available_value) }));

    const brandAgg = [...groupBy(skuRows, (s) => s.brand_name)].map(([b, xs]) => ({
      brand: b, skus: xs.length, restocked: sum(xs.map((x) => x.restocked)), available: sum(xs.map((x) => x.available)),
      value: round2(sum(xs.map((x) => x.available_value))), dispatched: sum(xs.map((x) => x.dispatched)), brand_stock_used: sum(xs.map((x) => x.brand_stock_used)),
    }));
    const itemCols: Column[] = [
      { header: "Product", key: "product_name", width: 30 }, { header: "SKU", key: "sku", width: 16 }, { header: "Variant", key: "variant", width: 14 },
      col.order, col.brand, { header: "Customer", key: "customer_name" }, { header: "City", key: "city", width: 16 },
    ];
    return {
      title: "Stock report",
      filters: filterLines(f, ["Current stock position (no date filter)"]),
      figures: [
        fig("SKUs", skuRows.length), fig("Units restocked", sum(restockRows.map((r) => r.quantity))),
        fig("Units available", sum(restockRows.map((r) => r.available))), fig("Available stock value", round2(sum(restockRows.map((r) => r.available_value))), "money", true),
        fig("Units dispatched from BD warehouse", sum(dispatchRows.map((r) => r.quantity))),
        fig("Units fulfilled from brand BD stock", sum(localRows.map((r) => r.inventory_qty))),
      ],
      breakdowns: [breakdown("By brand", [
        { header: "Brand", key: "brand" }, col.n("SKUs", "skus"), col.n("Restocked", "restocked"), col.n("Available", "available"),
        col.money("Available value", "value"), col.n("Dispatched", "dispatched"), col.n("Brand stock used", "brand_stock_used"),
      ], brandAgg, "available")],
      sheets: [
        {
          name: "SKU summary",
          columns: [
            col.brand, { header: "SKU", key: "sku", width: 16 }, { header: "Product", key: "product_name", width: 30 }, { header: "Variant", key: "variant", width: 14 },
            col.n("Restocked", "restocked"), col.n("Available", "available"), col.money("Available value", "available_value"),
            col.n("Dispatched", "dispatched"), col.n("Brand stock used", "brand_stock_used"),
          ],
          rows: skuRows,
        },
        {
          name: "Restocked items",
          columns: [
            ...itemCols, col.n("Qty", "quantity", 8), col.n("Available", "available", 9), { header: "Disposition", key: "disposition", width: 16 },
            { header: "Returned", key: "returned_at", type: "datetime" }, { header: "Restocked", key: "restocked_at", type: "datetime" },
            { header: "Shipment", key: "shipment_code", width: 12 }, { header: "Note", key: "restock_note", width: 28 },
            col.money("Unit price", "unit_price"), col.money("Line total", "line_total"), col.money("Available value", "available_value"),
            { header: "Currency", key: "currency", width: 9, money: true },
          ],
          rows: restockRows,
        },
        {
          name: "Dispatched from stock",
          columns: [
            ...itemCols, { header: "Status", key: "status_label", width: 18 }, col.n("Qty", "quantity", 8),
            { header: "Dispatched", key: "dispatched_at", type: "datetime" }, { header: "Delivered", key: "delivered_at", type: "datetime" },
            { header: "Courier", key: "delivery_courier", width: 14 }, { header: "Shipment", key: "shipment_code", width: 12 },
            col.money("Unit price", "unit_price"), col.money("Line total", "line_total"), { header: "Currency", key: "currency", width: 9, money: true },
          ],
          rows: dispatchRows,
        },
        {
          name: "Brand BD stock used",
          columns: [
            ...itemCols, { header: "Order date", key: "order_date", type: "datetime" }, { header: "Status", key: "status_label", width: 18 },
            col.n("Ordered", "quantity", 9), col.n("From brand stock", "inventory_qty", 10),
          ],
          rows: localRows,
        },
      ],
    };
  },
};

export const V360_OPS_REPORTS: ReportDef[] = [
  brandDispatches, hubReceiving, hubIssues,
  shipmentRegister, shipmentManifest, transitPerformance,
  confirmations, deliveryPerformance, codCollection, returns, bdDiscrepancies, stock,
];

