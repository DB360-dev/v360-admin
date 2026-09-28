import { supabase } from "@/lib/supabase";
import type { OrderEvent, OrderItem, OrderOverview, OrderStatus } from "@/lib/types";
import { GROUP_LABEL, STATUS, TERMINAL, type StatusGroup } from "@/lib/status";
import type { Column } from "@/lib/excel";
import type { ReportDef, ReportFilters } from "./types";
import { avg, chunk, daysBetween, fetchAll, fig, filterLines, groupBy, inRange, median, statusLabel, sum } from "./util";

// ---------------------------------------------------------------- shared loaders

/** Orders from order_overview, filtered by order date / brand / status. */
export async function loadOrders(f: ReportFilters, progress: (t: string) => void, dateColumn = "order_date"): Promise<OrderOverview[]> {
  return fetchAll<OrderOverview>((from, to) => {
    let q = supabase.from("order_overview").select("*");
    q = inRange(q, dateColumn, f);
    if (f.brandId) q = q.eq("brand_id", f.brandId);
    if (f.status) q = q.eq("status", f.status);
    return q.order("order_date", { ascending: true }).order("id").range(from, to);
  }, (n) => progress(`Loading orders… ${n.toLocaleString()}`));
}

/** Status events for these orders (for "date reached each stage"). */
export async function loadEvents(orderIds: string[], progress: (t: string) => void): Promise<OrderEvent[]> {
  const out: OrderEvent[] = [];
  for (const ids of chunk(orderIds)) {
    const rows = await fetchAll<OrderEvent>((from, to) =>
      supabase.from("order_events").select("id, order_id, actor_label, action, from_status, to_status, note, created_at")
        .in("order_id", ids).order("id").range(from, to));
    out.push(...rows);
    progress(`Loading order history… ${out.length.toLocaleString()}`);
  }
  return out;
}

/** order id → status → first time the order reached it. */
export function firstReached(events: OrderEvent[]): Map<string, Partial<Record<OrderStatus, string>>> {
  const m = new Map<string, Partial<Record<OrderStatus, string>>>();
  for (const e of events) {
    if (!e.to_status) continue;
    const s = m.get(e.order_id) ?? {};
    if (!s[e.to_status] || e.created_at < s[e.to_status]!) s[e.to_status] = e.created_at;
    m.set(e.order_id, s);
  }
  return m;
}

/** Order-level columns shared by several reports. */
export const ORDER_COLUMNS: Column[] = [
  { header: "Order", key: "order_number", width: 14 },
  { header: "Order date", key: "order_date", type: "datetime" },
  { header: "Brand", key: "brand_name" },
  { header: "Customer", key: "customer_name" },
  { header: "Phone", key: "customer_phone", width: 16 },
  { header: "City", key: "city", width: 16 },
  { header: "Status", key: "status_label", width: 20 },
  { header: "Status since", key: "status_changed_at", type: "datetime" },
  { header: "Items", key: "item_count", type: "number", width: 8 },
  { header: "SKUs", key: "skus", width: 30 },
  { header: "Order total", key: "order_total", type: "money", money: true },
  { header: "Currency", key: "currency", width: 9, money: true },
  { header: "COD expected", key: "cod_amount_expected", type: "money", money: true },
  { header: "COD collected", key: "cod_amount_collected", type: "money", money: true },
];

// ---------------------------------------------------------------- V1 Order register

const STAGES: { status: OrderStatus; header: string }[] = [
  { status: "confirmed", header: "Confirmed" },
  { status: "brand_preparing", header: "Brand preparing" },
  { status: "dispatched_to_hub", header: "Dispatched to hub" },
  { status: "received_at_hub", header: "Received at hub" },
  { status: "ready_for_shipment", header: "Ready for shipment" },
  { status: "shipped", header: "Shipped" },
  { status: "arrived_bd", header: "Arrived BD" },
  { status: "received_by_partner", header: "Received by KBB" },
  { status: "out_for_delivery", header: "Out for delivery" },
  { status: "delivered", header: "Delivered" },
  { status: "cancelled", header: "Cancelled" },
  { status: "returned", header: "Returned" },
];

const orderRegister: ReportDef = {
  code: "V1", perm: "reports.order_register", side: "v360", category: "Orders",
  title: "Order register",
  description: "Every order with all its details, current status and the date it reached each stage.",
  filters: ["dateRange", "brand", "status"],
  async run(f, ctx) {
    const orders = await loadOrders(f, ctx.progress);
    const reached = firstReached(await loadEvents(orders.map((o) => o.id), ctx.progress));
    const rows = orders.map((o) => {
      const r: Record<string, unknown> = { ...o, status_label: statusLabel(o.status) };
      const s = reached.get(o.id) ?? {};
      for (const st of STAGES) r[`at_${st.status}`] = s[st.status] ?? null;
      r.shipment_code = o.shipment_code;
      r.tracking = o.delivery_tracking_number ?? o.shipment_tracking ?? o.inbound_tracking;
      return r;
    });
    const byStatus = [...groupBy(orders, (o) => o.status)].map(([s, os]) => ({ status: statusLabel(s), orders: os.length, value: sum(os.map((o) => o.order_total)) }));
    const byBrand = [...groupBy(orders, (o) => o.brand_name)].map(([b, os]) => ({ brand: b, orders: os.length, value: sum(os.map((o) => o.order_total)) }));
    return {
      title: "Order register",
      filters: filterLines(f),
      figures: [
        fig("Orders", orders.length),
        fig("Order value", sum(orders.map((o) => o.order_total)), "money", true),
        fig("Delivered", orders.filter((o) => o.status === "delivered").length),
        fig("Cancelled", orders.filter((o) => o.status === "cancelled").length),
      ],
      breakdowns: [
        { name: "By status", columns: [{ header: "Status", key: "status" }, { header: "Orders", key: "orders", type: "number" }, { header: "Value", key: "value", type: "money", money: true }], rows: byStatus.sort((a, b) => b.orders - a.orders) },
        { name: "By brand", columns: [{ header: "Brand", key: "brand" }, { header: "Orders", key: "orders", type: "number" }, { header: "Value", key: "value", type: "money", money: true }], rows: byBrand.sort((a, b) => b.orders - a.orders) },
      ],
      sheets: [{
        name: "Orders",
        columns: [
          ...ORDER_COLUMNS,
          { header: "Shipment", key: "shipment_code", width: 12 },
          { header: "Tracking", key: "tracking", width: 18 },
          ...STAGES.map((st): Column => ({ header: st.header, key: `at_${st.status}`, type: "datetime" })),
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V2 Status snapshot

const GROUPS = Object.keys(GROUP_LABEL) as StatusGroup[];

const statusSnapshot: ReportDef = {
  code: "V2", perm: "reports.status_snapshot", side: "v360", category: "Orders",
  title: "Status snapshot",
  description: "How many orders sit in each status right now, per brand.",
  filters: ["brand"],
  async run(f, ctx) {
    const orders = await loadOrders({ ...f, from: null, to: null, status: null }, ctx.progress);
    const byStatus = [...groupBy(orders, (o) => o.status)].map(([s, os]) => ({ status: statusLabel(s), group: GROUP_LABEL[STATUS[s]?.group] ?? "", orders: os.length, value: sum(os.map((o) => o.order_total)) }));
    const pivot = [...groupBy(orders, (o) => o.brand_name)].map(([b, os]) => {
      const r: Record<string, unknown> = { brand: b, total: os.length };
      for (const g of GROUPS) r[g] = os.filter((o) => STATUS[o.status]?.group === g).length;
      return r;
    }).sort((a, b) => (b.total as number) - (a.total as number));
    const rows = [...groupBy(orders, (o) => `${o.brand_name}\u0000${o.status}`)].map(([, os]) => ({
      brand: os[0].brand_name, status: statusLabel(os[0].status), group: GROUP_LABEL[STATUS[os[0].status]?.group] ?? "",
      orders: os.length, value: sum(os.map((o) => o.order_total)),
    })).sort((a, b) => a.brand.localeCompare(b.brand) || b.orders - a.orders);
    const open = orders.filter((o) => !TERMINAL.includes(o.status));
    return {
      title: "Status snapshot",
      filters: filterLines(f, ["All orders, current status"]),
      figures: [
        fig("Orders", orders.length),
        fig("Open orders", open.length),
        fig("Open order value", sum(open.map((o) => o.order_total)), "money", true),
        fig("Delivered", orders.filter((o) => o.status === "delivered").length),
        fig("Cancelled", orders.filter((o) => o.status === "cancelled").length),
        fig("Returned", orders.filter((o) => o.status === "returned").length),
      ],
      breakdowns: [
        { name: "By status", columns: [{ header: "Status", key: "status" }, { header: "Group", key: "group" }, { header: "Orders", key: "orders", type: "number" }, { header: "Value", key: "value", type: "money", money: true }], rows: byStatus.sort((a, b) => b.orders - a.orders) },
        { name: "Brand × status group", columns: [{ header: "Brand", key: "brand" }, ...GROUPS.map((g): Column => ({ header: GROUP_LABEL[g], key: g, type: "number" })), { header: "Total", key: "total", type: "number" }], rows: pivot },
      ],
      sheets: [{
        name: "Brand by status",
        columns: [
          { header: "Brand", key: "brand" },
          { header: "Status", key: "status", width: 22 },
          { header: "Group", key: "group", width: 14 },
          { header: "Orders", key: "orders", type: "number" },
          { header: "Value", key: "value", type: "money", money: true },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V3 Ageing / stuck orders

const AGE_BUCKETS: { label: string; max: number }[] = [
  { label: "0–2 days", max: 2 },
  { label: "3–7 days", max: 7 },
  { label: "8–14 days", max: 14 },
  { label: "15–30 days", max: 30 },
  { label: "30+ days", max: Infinity },
];
const ageBucket = (d: number) => AGE_BUCKETS.find((b) => Math.floor(d) <= b.max)!.label;

const orderAgeing: ReportDef = {
  code: "V3", perm: "reports.order_ageing", side: "v360", category: "Orders",
  title: "Ageing / stuck orders",
  description: "Open orders and how many days they have been in their current status.",
  filters: ["brand", "status"],
  async run(f, ctx) {
    const now = new Date().toISOString();
    const orders = (await loadOrders({ ...f, from: null, to: null }, ctx.progress)).filter((o) => !TERMINAL.includes(o.status));
    const rows = orders.map((o) => {
      const days = Math.max(0, daysBetween(o.status_changed_at, now) ?? 0);
      return { ...o, status_label: statusLabel(o.status), days, bucket: ageBucket(days) } as Record<string, unknown> & OrderOverview & { days: number; bucket: string };
    }).sort((a, b) => b.days - a.days);
    const days = rows.map((r) => r.days);
    const byStatus = [...groupBy(rows, (r) => r.status)].map(([s, rs]) => ({
      status: statusLabel(s), orders: rs.length, avg: avg(rs.map((r) => r.days)), max: Math.max(...rs.map((r) => r.days)),
      over7: rs.filter((r) => r.days > 7).length, value: sum(rs.map((r) => r.order_total)),
    })).sort((a, b) => b.orders - a.orders);
    const byBucket = AGE_BUCKETS.map((b) => {
      const rs = rows.filter((r) => r.bucket === b.label);
      return { bucket: b.label, orders: rs.length, value: sum(rs.map((r) => r.order_total)) };
    });
    return {
      title: "Ageing - stuck orders",
      filters: filterLines(f, ["Open orders only (not delivered, cancelled or returned)", "Days = time since the order entered its current status"]),
      figures: [
        fig("Open orders", rows.length),
        fig("Open order value", sum(rows.map((r) => r.order_total)), "money", true),
        fig("Average days in status", avg(days), "days"),
        fig("Median days in status", median(days), "days"),
        fig("Over 7 days", rows.filter((r) => r.days > 7).length),
        fig("Over 30 days", rows.filter((r) => r.days > 30).length),
      ],
      breakdowns: [
        { name: "By status", columns: [{ header: "Status", key: "status" }, { header: "Orders", key: "orders", type: "number" }, { header: "Avg days", key: "avg", type: "days" }, { header: "Max days", key: "max", type: "days" }, { header: "Over 7 days", key: "over7", type: "number" }, { header: "Value", key: "value", type: "money", money: true }], rows: byStatus },
        { name: "By age", columns: [{ header: "Days in status", key: "bucket" }, { header: "Orders", key: "orders", type: "number" }, { header: "Value", key: "value", type: "money", money: true }], rows: byBucket },
      ],
      sheets: [{
        name: "Open orders",
        columns: [
          ...ORDER_COLUMNS,
          { header: "Days in status", key: "days", type: "days" },
          { header: "Age bucket", key: "bucket", width: 12 },
          { header: "Shipment", key: "shipment_code", width: 12 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V4 Turnaround times

const TURNAROUND: { key: string; header: string; from: OrderStatus | "order"; to: OrderStatus }[] = [
  { key: "t_confirm", header: "Order → confirmed", from: "order", to: "confirmed" },
  { key: "t_dispatch", header: "Confirmed → dispatched", from: "confirmed", to: "dispatched_to_hub" },
  { key: "t_hub", header: "Dispatched → at hub", from: "dispatched_to_hub", to: "received_at_hub" },
  { key: "t_ship", header: "At hub → shipped", from: "received_at_hub", to: "shipped" },
  { key: "t_kbb", header: "Shipped → KBB", from: "shipped", to: "received_by_partner" },
  { key: "t_deliver", header: "KBB → delivered", from: "received_by_partner", to: "delivered" },
  { key: "t_total", header: "Order → delivered", from: "order", to: "delivered" },
];

function stageStats(rows: Record<string, unknown>[]): Record<string, unknown> {
  const r: Record<string, unknown> = { orders: rows.length };
  for (const st of TURNAROUND) {
    const xs = rows.map((x) => x[st.key]).filter((v): v is number => typeof v === "number");
    r[`${st.key}_n`] = xs.length;
    r[`${st.key}_avg`] = avg(xs);
    r[`${st.key}_med`] = median(xs);
  }
  return r;
}

const turnaround: ReportDef = {
  code: "V4", perm: "reports.turnaround", side: "v360", category: "Orders",
  title: "Turnaround times",
  description: "Days between each stage of the order journey, per brand (average and median).",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const orders = await loadOrders({ ...f, status: null }, ctx.progress);
    const reached = firstReached(await loadEvents(orders.map((o) => o.id), ctx.progress));
    const rows = orders.map((o) => {
      const s = reached.get(o.id) ?? {};
      const at = (k: OrderStatus | "order") => (k === "order" ? o.order_date : s[k] ?? null);
      const r: Record<string, unknown> = { ...o, status_label: statusLabel(o.status) };
      for (const st of TURNAROUND) r[st.key] = daysBetween(at(st.from), at(st.to));
      return r;
    });
    const overall = stageStats(rows);
    const perBrand = [...groupBy(rows, (r) => r.brand_name as string)]
      .map(([b, rs]): Record<string, unknown> => ({ brand: b, ...stageStats(rs) }))
      .sort((a, b) => (b.orders as number) - (a.orders as number));
    const statCols: Column[] = TURNAROUND.flatMap((st): Column[] => [
      { header: `${st.header} (n)`, key: `${st.key}_n`, type: "number", width: 10 },
      { header: `${st.header} avg`, key: `${st.key}_avg`, type: "days", width: 14 },
      { header: `${st.header} median`, key: `${st.key}_med`, type: "days", width: 14 },
    ]);
    return {
      title: "Turnaround times",
      filters: filterLines(f, ["Orders by order date", "Stage dates = first time the order reached that status"]),
      figures: [
        fig("Orders", orders.length),
        fig("Delivered orders measured", overall.t_total_n as number),
        ...TURNAROUND.map((st) => fig(`${st.header} (avg days)`, overall[`${st.key}_avg`] as number | null, "days")),
      ],
      breakdowns: [
        { name: "By brand", columns: [{ header: "Brand", key: "brand" }, { header: "Orders", key: "orders", type: "number" }, ...statCols], rows: [...perBrand, { brand: "All brands", ...overall }] },
      ],
      sheets: [{
        name: "Orders",
        columns: [
          { header: "Order", key: "order_number", width: 14 },
          { header: "Order date", key: "order_date", type: "datetime" },
          { header: "Brand", key: "brand_name" },
          { header: "Status", key: "status_label", width: 20 },
          ...TURNAROUND.map((st): Column => ({ header: st.header, key: st.key, type: "days", width: 14 })),
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V5 SKU / items report

type ItemRow = Pick<OrderItem, "order_id" | "product_name" | "sku" | "variant" | "quantity" | "unit_price" | "discount" | "received_quantity">;

async function loadItems(orderIds: string[], progress: (t: string) => void): Promise<ItemRow[]> {
  const out: ItemRow[] = [];
  for (const ids of chunk(orderIds)) {
    const rows = await fetchAll<ItemRow>((from, to) =>
      supabase.from("order_items").select("id, order_id, product_name, sku, variant, quantity, unit_price, discount, received_quantity")
        .in("order_id", ids).order("id").range(from, to));
    out.push(...rows);
    progress(`Loading order items… ${out.length.toLocaleString()}`);
  }
  return out;
}

const lineValue = (i: ItemRow) => (Number(i.quantity) || 0) * (Number(i.unit_price) || 0) - (Number(i.discount) || 0);

const skuSales: ReportDef = {
  code: "V5", perm: "reports.sku_sales", side: "v360", category: "Orders",
  title: "SKU / items report",
  description: "Units ordered, delivered, returned and cancelled per SKU and brand.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const orders = await loadOrders({ ...f, status: null }, ctx.progress);
    const byId = new Map(orders.map((o) => [o.id, o]));
    const items = (await loadItems(orders.map((o) => o.id), ctx.progress)).filter((i) => byId.has(i.order_id));
    const rows = [...groupBy(items, (i) => `${byId.get(i.order_id)!.brand_name}\u0000${(i.sku || i.product_name || "").trim()}`)].map(([, is]) => {
      const o = (i: ItemRow) => byId.get(i.order_id)!;
      const of = (s: OrderStatus) => is.filter((i) => o(i).status === s);
      const delivered = of("delivered");
      return {
        brand: o(is[0]).brand_name,
        sku: is[0].sku ?? "",
        product: is[0].product_name,
        variants: [...new Set(is.map((i) => i.variant).filter(Boolean))].join(", "),
        orders: new Set(is.map((i) => i.order_id)).size,
        ordered: sum(is.map((i) => i.quantity)),
        delivered: sum(delivered.map((i) => i.quantity)),
        returned: sum(of("returned").map((i) => i.quantity)),
        cancelled: sum(of("cancelled").map((i) => i.quantity)),
        open: sum(is.filter((i) => !TERMINAL.includes(o(i).status)).map((i) => i.quantity)),
        revenue: sum(delivered.map(lineValue)),
      };
    }).sort((a, b) => b.ordered - a.ordered);
    const qty = (s: OrderStatus) => sum(items.filter((i) => byId.get(i.order_id)!.status === s).map((i) => i.quantity));
    const byBrand = [...groupBy(rows, (r) => r.brand)].map(([b, rs]) => ({
      brand: b, skus: rs.length, ordered: sum(rs.map((r) => r.ordered)), delivered: sum(rs.map((r) => r.delivered)),
      returned: sum(rs.map((r) => r.returned)), cancelled: sum(rs.map((r) => r.cancelled)), revenue: sum(rs.map((r) => r.revenue)),
    })).sort((a, b) => b.ordered - a.ordered);
    const unitCols: Column[] = [
      { header: "Units ordered", key: "ordered", type: "number" },
      { header: "Units delivered", key: "delivered", type: "number" },
      { header: "Units returned", key: "returned", type: "number" },
      { header: "Units cancelled", key: "cancelled", type: "number" },
    ];
    return {
      title: "SKU - items report",
      filters: filterLines(f, ["Orders by order date", "Revenue delivered = quantity × unit price − line discount, delivered orders only"]),
      figures: [
        fig("Orders", orders.length),
        fig("SKUs", rows.length),
        fig("Units ordered", sum(items.map((i) => i.quantity))),
        fig("Units delivered", qty("delivered")),
        fig("Units returned", qty("returned")),
        fig("Units cancelled", qty("cancelled")),
        fig("Revenue delivered", sum(rows.map((r) => r.revenue)), "money", true),
      ],
      breakdowns: [
        { name: "Top 20 SKUs", columns: [{ header: "Brand", key: "brand" }, { header: "SKU", key: "sku", width: 16 }, { header: "Product", key: "product", width: 30 }, ...unitCols, { header: "Revenue delivered", key: "revenue", type: "money", money: true }], rows: rows.slice(0, 20) },
        { name: "By brand", columns: [{ header: "Brand", key: "brand" }, { header: "SKUs", key: "skus", type: "number" }, ...unitCols, { header: "Revenue delivered", key: "revenue", type: "money", money: true }], rows: byBrand },
      ],
      sheets: [{
        name: "SKUs",
        columns: [
          { header: "Brand", key: "brand" },
          { header: "SKU", key: "sku", width: 16 },
          { header: "Product", key: "product", width: 34 },
          { header: "Variants", key: "variants", width: 24 },
          { header: "Orders", key: "orders", type: "number" },
          ...unitCols,
          { header: "Units open", key: "open", type: "number" },
          { header: "Revenue delivered", key: "revenue", type: "money", money: true },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- shared: events in a date range

type OrderRef = Pick<OrderOverview, "id" | "order_number" | "brand_id" | "brand_name" | "status">;

/**
 * Order events created in the date range (optionally only certain to_statuses),
 * plus the order they belong to. With a brand filter, only that brand's orders.
 */
async function loadEventsInRange(f: ReportFilters, progress: (t: string) => void, toStatuses?: OrderStatus[]): Promise<{ events: OrderEvent[]; orders: Map<string, OrderRef> }> {
  const cols = "id, order_id, actor_label, action, from_status, to_status, note, created_at";
  const orders = new Map<string, OrderRef>();
  const events: OrderEvent[] = [];
  const onPage = (n: number) => progress(`Loading order history… ${(events.length + n).toLocaleString()}`);
  if (f.brandId) {
    const own = await loadOrders({ ...f, from: null, to: null, status: null }, progress);
    for (const o of own) orders.set(o.id, o);
    for (const ids of chunk(own.map((o) => o.id))) {
      events.push(...await fetchAll<OrderEvent>((from, to) => {
        let q = supabase.from("order_events").select(cols).in("order_id", ids);
        q = inRange(q, "created_at", f);
        if (toStatuses) q = q.in("to_status", toStatuses);
        return q.order("id").range(from, to);
      }, onPage));
    }
  } else {
    events.push(...await fetchAll<OrderEvent>((from, to) => {
      let q = supabase.from("order_events").select(cols);
      q = inRange(q, "created_at", f);
      if (toStatuses) q = q.in("to_status", toStatuses);
      return q.order("id").range(from, to);
    }, onPage));
    const ids = [...new Set(events.map((e) => e.order_id))];
    for (const c of chunk(ids)) {
      const rows = await fetchAll<OrderRef>((from, to) =>
        supabase.from("order_overview").select("id, order_number, brand_id, brand_name, status").in("id", c).order("id").range(from, to));
      for (const o of rows) orders.set(o.id, o);
      progress(`Loading orders… ${orders.size.toLocaleString()}`);
    }
  }
  events.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  return { events, orders };
}

function eventRow(e: OrderEvent, o: OrderRef | undefined): Record<string, unknown> {
  return {
    created_at: e.created_at,
    order_number: o?.order_number ?? "",
    brand_name: o?.brand_name ?? "",
    action: e.action,
    from_label: statusLabel(e.from_status),
    to_label: statusLabel(e.to_status),
    actor: e.actor_label ?? "",
    note: e.note ?? "",
    current_status: statusLabel(o?.status),
    override: /override/i.test(e.action ?? "") ? "Yes" : "",
  };
}

// ---------------------------------------------------------------- V6 Cancellations & holds

const cancellationsHolds: ReportDef = {
  code: "V6", perm: "reports.cancellations_holds", side: "v360", category: "Orders",
  title: "Cancellations & holds",
  description: "Every cancellation and hold: who did it, when, why and what status the order was in.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const { events, orders } = await loadEventsInRange(f, ctx.progress, ["cancelled", "hold"]);
    const rows = events.map((e) => ({ ...eventRow(e, orders.get(e.order_id)), kind: e.to_status === "cancelled" ? "Cancelled" : "Hold" }));
    const cancels = events.filter((e) => e.to_status === "cancelled");
    const holds = events.filter((e) => e.to_status === "hold");
    const brandOf = (e: OrderEvent) => orders.get(e.order_id)?.brand_name ?? "Unknown";
    const byBrand = [...groupBy(events, brandOf)].map(([b, es]) => ({
      brand: b, cancelled: es.filter((e) => e.to_status === "cancelled").length, hold: es.filter((e) => e.to_status === "hold").length,
    })).sort((a, b) => b.cancelled - a.cancelled || b.hold - a.hold);
    const byFrom = [...groupBy(cancels, (e) => statusLabel(e.from_status) || "Unknown")].map(([s, es]) => ({ status: s, cancelled: es.length }))
      .sort((a, b) => b.cancelled - a.cancelled);
    const byActor = [...groupBy(events, (e) => e.actor_label ?? "Unknown")].map(([a, es]) => ({
      actor: a, cancelled: es.filter((e) => e.to_status === "cancelled").length, hold: es.filter((e) => e.to_status === "hold").length,
    })).sort((a, b) => b.cancelled + b.hold - (a.cancelled + a.hold));
    return {
      title: "Cancellations and holds",
      filters: filterLines(f, ["By date of the status change"]),
      figures: [
        fig("Cancellations", cancels.length),
        fig("Orders cancelled", new Set(cancels.map((e) => e.order_id)).size),
        fig("Holds", holds.length),
        fig("Orders put on hold", new Set(holds.map((e) => e.order_id)).size),
      ],
      breakdowns: [
        { name: "By brand", columns: [{ header: "Brand", key: "brand" }, { header: "Cancellations", key: "cancelled", type: "number" }, { header: "Holds", key: "hold", type: "number" }], rows: byBrand },
        { name: "Cancelled from status", columns: [{ header: "Status before", key: "status" }, { header: "Cancellations", key: "cancelled", type: "number" }], rows: byFrom },
        { name: "By person", columns: [{ header: "Who", key: "actor" }, { header: "Cancellations", key: "cancelled", type: "number" }, { header: "Holds", key: "hold", type: "number" }], rows: byActor },
      ],
      sheets: [{
        name: "Cancellations & holds",
        columns: [
          { header: "When", key: "created_at", type: "datetime" },
          { header: "Type", key: "kind", width: 11 },
          { header: "Order", key: "order_number", width: 14 },
          { header: "Brand", key: "brand_name" },
          { header: "Status before", key: "from_label", width: 20 },
          { header: "Who", key: "actor", width: 20 },
          { header: "Reason", key: "note", width: 40 },
          { header: "Current status", key: "current_status", width: 20 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V7 Status history / audit

const statusHistory: ReportDef = {
  code: "V7", perm: "reports.status_history", side: "v360", category: "Orders",
  title: "Status history / audit",
  description: "Every order status change in the period, with who made it; overrides flagged.",
  filters: ["dateRange", "brand"],
  async run(f, ctx) {
    const { events, orders } = await loadEventsInRange(f, ctx.progress);
    const rows = events.map((e) => eventRow(e, orders.get(e.order_id)));
    const overrides = rows.filter((r) => r.override);
    const byActor = [...groupBy(rows, (r) => (r.actor as string) || "Unknown")].map(([a, rs]) => ({
      actor: a, events: rs.length, overrides: rs.filter((r) => r.override).length,
    })).sort((a, b) => b.events - a.events);
    const byAction = [...groupBy(rows, (r) => r.action as string)].map(([a, rs]) => ({ action: a, events: rs.length }))
      .sort((a, b) => b.events - a.events);
    return {
      title: "Status history - audit",
      filters: filterLines(f, ["By date of the event"]),
      figures: [
        fig("Events", rows.length),
        fig("Orders touched", new Set(events.map((e) => e.order_id)).size),
        fig("Overrides", overrides.length),
        fig("People", byActor.length),
      ],
      breakdowns: [
        { name: "By person", columns: [{ header: "Who", key: "actor" }, { header: "Events", key: "events", type: "number" }, { header: "Overrides", key: "overrides", type: "number" }], rows: byActor },
        { name: "By action", columns: [{ header: "Action", key: "action", width: 28 }, { header: "Events", key: "events", type: "number" }], rows: byAction },
      ],
      sheets: [{
        name: "Events",
        columns: [
          { header: "When", key: "created_at", type: "datetime" },
          { header: "Order", key: "order_number", width: 14 },
          { header: "Brand", key: "brand_name" },
          { header: "Action", key: "action", width: 24 },
          { header: "From", key: "from_label", width: 20 },
          { header: "To", key: "to_label", width: 20 },
          { header: "Who", key: "actor", width: 20 },
          { header: "Note", key: "note", width: 40 },
          { header: "Override", key: "override", width: 9 },
        ],
        rows,
      }],
    };
  },
};

export const V360_ORDER_REPORTS: ReportDef[] = [orderRegister, statusSnapshot, orderAgeing, turnaround, skuSales, cancellationsHolds, statusHistory];
