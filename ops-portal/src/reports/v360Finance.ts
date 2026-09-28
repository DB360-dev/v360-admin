import { supabase } from "@/lib/supabase";
import type {
  BrandPayable, BrandRow, BrandShippingInvoice, BrandShippingInvoiceLine, FxRate, InvoicePaymentStatus, InvoiceRecord,
  KbbOrderAccount, KbbPayment, KbbPaymentKind, MoneySettings, OrderOverview, OrderStatus, PermissionDef, RoleRow,
  Settlement, SettlementLine, ShipmentOverview, TeamMember, WebhookEvent,
} from "@/lib/types";
import type { Column, Row } from "@/lib/excel";
import { ROLE_LABEL } from "@/lib/status";
import type { ReportDef, ReportFilters } from "./types";
import { chunk, daysBetween, fetchAll, fig, filterLines, groupBy, inRange, median, monthKey, ratio, sum, within } from "./util";
import { loadOrders } from "./v360Orders";

// ---------------------------------------------------------------- shared

const PAY_LABEL: Record<InvoicePaymentStatus, string> = { not_paid: "Unpaid", partially_paid: "Partially paid", paid: "Paid" };
const payLabel = (s: string | null | undefined) => (s ? PAY_LABEL[s as InvoicePaymentStatus] ?? s : "Unpaid");

const TYPE_LABEL: Record<string, string> = {
  dispatch_advance: "Dispatch advance (KBB)",
  final_settlement: "Final settlement (KBB)",
  brand_payout: "Brand payout",
  brand_shipping: "Brand shipping charges",
};

const ORG_TYPE_LABEL: Record<string, string> = { v360: "V360", partner: "KBB", brand: "Brand" };

const money = (header: string, key: string, width?: number): Column => ({ header, key, type: "money", money: true, width });
/** 2-decimal number that is not a money amount (weights, FX rates). */
const decimal = (header: string, key: string, width?: number): Column => ({ header, key, type: "money", width });

/** Full order value in PKR (paid online included), for commissions: orders.money_full_pkr (migration 055). */
async function loadFullValuesPkr(ids: string[], progress: (t: string) => void): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunk(ids)) {
    const rows = await fetchAll<{ id: string; money_full_pkr: number | null }>((from, to) =>
      supabase.from("orders").select("id, money_full_pkr").in("id", part).order("id").range(from, to));
    for (const r of rows) out.set(r.id, Number(r.money_full_pkr ?? 0));
    progress(`Loading order values… ${out.size.toLocaleString()}`);
  }
  return out;
}

const today = () => new Date().toISOString();

async function loadBrandNames(): Promise<Map<string, string>> {
  const rows = await fetchAll<{ id: string; name: string }>((from, to) =>
    supabase.from("organizations").select("id, name").eq("type", "brand").order("name").order("id").range(from, to));
  return new Map(rows.map((b) => [b.id, b.name]));
}

async function loadShipments(progress: (t: string) => void): Promise<ShipmentOverview[]> {
  return fetchAll<ShipmentOverview>((from, to) =>
    supabase.from("shipment_overview").select("*").order("created_at", { ascending: false }).order("id").range(from, to),
  (n) => progress(`Loading shipments… ${n.toLocaleString()}`));
}

async function loadShippingInvoices(f: ReportFilters, progress: (t: string) => void, useRange: boolean): Promise<BrandShippingInvoice[]> {
  return fetchAll<BrandShippingInvoice>((from, to) => {
    let q = supabase.from("brand_shipping_invoices")
      .select("*, brand:organizations(name), shipment:shipments(code, shipping_partner, tracking_number, dispatched_at)");
    if (useRange) q = inRange(q, "created_at", f);
    if (f.brandId) q = q.eq("brand_id", f.brandId);
    if (f.shipmentId) q = q.eq("shipment_id", f.shipmentId);
    return q.order("created_at", { ascending: true }).order("id").range(from, to);
  }, (n) => progress(`Loading shipping invoices… ${n.toLocaleString()}`));
}

/** One invoice of any kind, flattened for the register / ageing. */
interface InvoiceLine {
  invoice_number: string;
  type: string;
  type_label: string;
  date: string;
  brand: string;
  /** Brand payout / shipping invoices only. */
  brand_id: string | null;
  shipments: string;
  order_count: number | null;
  total_value: number | null;
  advance_amount: number | null;
  net_remaining: number | null;
  amount: number;
  payment_status: InvoicePaymentStatus;
  payment_label: string;
  saved: boolean;
  paid_at: string | null;
  notes: string | null;
}

/**
 * Every invoice the Invoices page shows: saved invoices (dispatch advance, final settlement, brand payout),
 * per-shipment dispatch-advance invoices not saved yet (same fallback maths as the Invoices page) and
 * brand shipping-charges invoices. Amount = the figure the page headlines for each type.
 */
async function loadAllInvoices(f: ReportFilters, progress: (t: string) => void, useRange: boolean): Promise<{ lines: InvoiceLine[]; notes: string[] }> {
  const notes: string[] = [];
  const [saved, shipments, brands, shipping] = await Promise.all([
    fetchAll<InvoiceRecord>((from, to) => supabase.from("invoices").select("*").order("created_at", { ascending: true }).order("id").range(from, to),
      (n) => progress(`Loading invoices… ${n.toLocaleString()}`)),
    loadShipments(progress),
    loadBrandNames(),
    loadShippingInvoices({ ...f, shipmentId: null }, progress, false),
  ]);
  const shipCode = new Map(shipments.map((s) => [s.id, s.code]));
  const codes = (ids: string[] | null | undefined) => (ids ?? []).map((id) => shipCode.get(id) ?? id).join(", ");

  const lines: InvoiceLine[] = [];
  for (const inv of saved) {
    const isDisp = inv.invoice_type === "dispatch_advance";
    lines.push({
      invoice_number: inv.invoice_number,
      type: inv.invoice_type,
      type_label: TYPE_LABEL[inv.invoice_type] ?? inv.invoice_type,
      date: inv.created_at,
      brand: inv.invoice_type === "brand_payout" ? brands.get(inv.brand_id ?? "") ?? "" : "",
      shipments: codes(inv.shipment_ids) || (isDisp ? inv.invoice_number.replace("INV-DISP-", "") : ""),
      order_count: inv.order_count,
      total_value: Number(inv.total_value),
      advance_amount: Number(inv.advance_amount),
      net_remaining: Number(inv.net_remaining),
      amount: isDisp ? Number(inv.advance_amount) || 0.5 * Number(inv.total_value) : Number(inv.payable_amount),
      payment_status: inv.payment_status,
      payment_label: payLabel(inv.payment_status),
      saved: true,
      paid_at: null,
      notes: inv.notes,
      brand_id: inv.brand_id ?? null,
    });
  }
  // Dispatch-advance invoices the Invoices page derives from shipments not saved yet.
  const savedNums = new Set(saved.filter((i) => i.invoice_type === "dispatch_advance").map((i) => i.invoice_number));
  for (const s of shipments) {
    const num = `INV-DISP-${s.code}`;
    if (savedNums.has(num)) continue;
    const cod = Number(s.cod_expected) || 0;
    const advance = 0.5 * cod;
    const net = 0.5 * cod - cod * 0.08;
    lines.push({
      invoice_number: num, type: "dispatch_advance", type_label: TYPE_LABEL.dispatch_advance,
      date: s.dispatched_at || s.created_at, brand: "", brand_id: null, shipments: s.code, order_count: s.order_count,
      total_value: cod, advance_amount: advance, net_remaining: net, amount: advance,
      payment_status: s.invoice_payment_status || "not_paid", payment_label: payLabel(s.invoice_payment_status || "not_paid"),
      saved: false, paid_at: null, notes: null,
    });
  }
  for (const s of shipping) {
    lines.push({
      invoice_number: s.invoice_number, type: "brand_shipping", type_label: TYPE_LABEL.brand_shipping,
      date: s.created_at, brand: s.brand?.name ?? brands.get(s.brand_id) ?? "", shipments: s.shipment?.code ?? "",
      order_count: s.order_count, total_value: null, advance_amount: null, net_remaining: null, amount: Number(s.amount_pkr),
      payment_status: s.payment_status, payment_label: payLabel(s.payment_status), saved: true, paid_at: s.paid_at, notes: null, brand_id: s.brand_id,
    });
  }

  let out = lines;
  if (f.brandId) {
    out = out.filter((l) => l.brand_id === f.brandId);
    notes.push("Brand filter: KBB dispatch-advance and final-settlement invoices cover many brands, so they are left out.");
  }
  if (useRange) out = out.filter((l) => within(l.date, f));
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.invoice_number.localeCompare(b.invoice_number)));
  notes.push("Dispatch-advance invoices not saved yet are calculated from the shipment's COD expected, as on the Invoices page (Saved = No).");
  return { lines: out, notes };
}

const INVOICE_COLUMNS: Column[] = [
  { header: "Invoice", key: "invoice_number", width: 24 },
  { header: "Type", key: "type_label", width: 24 },
  { header: "Date", key: "date", type: "date" },
  { header: "Brand", key: "brand" },
  { header: "Shipment(s)", key: "shipments", width: 18 },
  { header: "Orders", key: "order_count", type: "number", width: 9 },
  money("Order value", "total_value"),
  money("Advance (50%)", "advance_amount"),
  money("Net remaining", "net_remaining"),
  money("Amount (PKR)", "amount"),
  { header: "Payment status", key: "payment_label", width: 15 },
  { header: "Saved", key: "saved_label", width: 8 },
];

// ---------------------------------------------------------------- V20 Invoice register

const invoiceRegister: ReportDef = {
  code: "V20", perm: "reports.invoice_register", side: "v360", category: "Finance",
  title: "Invoice register",
  description: "Every invoice: KBB dispatch advances and final settlements, brand payouts and brand shipping charges, with amounts and payment status.",
  filters: ["dateRange", "brand"],
  requires: ["invoices.view"],
  async run(f, ctx) {
    const { lines, notes } = await loadAllInvoices(f, ctx.progress, true);
    const rows = lines.map((l) => ({ ...l, saved_label: l.saved ? "Yes" : "No" }));
    const statuses: InvoicePaymentStatus[] = ["not_paid", "partially_paid", "paid"];
    const byType = [...groupBy(lines, (l) => l.type_label)].map(([t, ls]) => {
      const r: Row = { type: t, invoices: ls.length, amount: sum(ls.map((l) => l.amount)) };
      for (const s of statuses) {
        const g = ls.filter((l) => l.payment_status === s);
        r[`n_${s}`] = g.length;
        r[`a_${s}`] = sum(g.map((l) => l.amount));
      }
      return r;
    });
    return {
      title: "Invoice register",
      filters: filterLines(f),
      notes,
      figures: [
        fig("Invoices", lines.length),
        fig("Invoiced amount (PKR)", sum(lines.map((l) => l.amount)), "money", true),
        fig("Paid (PKR)", sum(lines.filter((l) => l.payment_status === "paid").map((l) => l.amount)), "money", true),
        fig("Unpaid / partially paid (PKR)", sum(lines.filter((l) => l.payment_status !== "paid").map((l) => l.amount)), "money", true),
      ],
      breakdowns: [{
        name: "By type and payment status",
        columns: [
          { header: "Type", key: "type", width: 24 }, { header: "Invoices", key: "invoices", type: "number" }, money("Amount", "amount"),
          ...statuses.flatMap((s): Column[] => [
            { header: `${PAY_LABEL[s]} (#)`, key: `n_${s}`, type: "number" }, money(`${PAY_LABEL[s]} (PKR)`, `a_${s}`),
          ]),
        ],
        rows: byType,
      }],
      sheets: [{ name: "Invoices", columns: INVOICE_COLUMNS, rows }],
    };
  },
};

// ---------------------------------------------------------------- V21 Unpaid invoices ageing

const BUCKETS = ["0–30 days", "31–60 days", "61–90 days", "90+ days"] as const;
const bucketOf = (d: number) => (d <= 30 ? BUCKETS[0] : d <= 60 ? BUCKETS[1] : d <= 90 ? BUCKETS[2] : BUCKETS[3]);

const unpaidAgeing: ReportDef = {
  code: "V21", perm: "reports.unpaid_ageing", side: "v360", category: "Finance",
  title: "Unpaid invoices ageing",
  description: "Unpaid and partially paid invoices, how many days old they are and which ageing bucket they fall in.",
  filters: ["brand"],
  requires: ["invoices.view"],
  async run(f, ctx) {
    const { lines, notes } = await loadAllInvoices(f, ctx.progress, false);
    const now = today();
    const open = lines.filter((l) => l.payment_status !== "paid").map((l) => {
      const age = Math.max(0, Math.floor(daysBetween(l.date, now) ?? 0));
      return { ...l, age, bucket: bucketOf(age), saved_label: l.saved ? "Yes" : "No" };
    }).sort((a, b) => b.age - a.age);
    const byBucket = BUCKETS.map((b) => {
      const g = open.filter((l) => l.bucket === b);
      return { bucket: b, invoices: g.length, amount: sum(g.map((l) => l.amount)) };
    });
    const byType = [...groupBy(open, (l) => l.type_label)].map(([t, ls]) => {
      const r: Row = { type: t, invoices: ls.length, amount: sum(ls.map((l) => l.amount)) };
      BUCKETS.forEach((b, i) => { r[`b${i}`] = sum(ls.filter((l) => l.bucket === b).map((l) => l.amount)); });
      return r;
    });
    return {
      title: "Unpaid invoices ageing",
      filters: filterLines(f, [`As of ${now.slice(0, 10)}`]),
      notes,
      figures: [
        fig("Open invoices", open.length),
        fig("Open amount (PKR)", sum(open.map((l) => l.amount)), "money", true),
        fig("Partially paid", open.filter((l) => l.payment_status === "partially_paid").length),
        fig("Over 90 days", open.filter((l) => l.age > 90).length),
      ],
      breakdowns: [
        { name: "By age", columns: [{ header: "Age", key: "bucket" }, { header: "Invoices", key: "invoices", type: "number" }, money("Amount (PKR)", "amount")], rows: byBucket },
        {
          name: "By type",
          columns: [
            { header: "Type", key: "type", width: 24 }, { header: "Invoices", key: "invoices", type: "number" }, money("Amount (PKR)", "amount"),
            ...BUCKETS.map((b, i) => money(b, `b${i}`)),
          ],
          rows: byType,
        },
      ],
      sheets: [{
        name: "Open invoices",
        columns: [...INVOICE_COLUMNS, { header: "Age (days)", key: "age", type: "number", width: 10 }, { header: "Bucket", key: "bucket", width: 12 }],
        rows: open,
      }],
    };
  },
};

// ---------------------------------------------------------------- V22 Payables & statements

const brandPayables: ReportDef = {
  code: "V22", perm: "reports.brand_payables", side: "v360", category: "Finance",
  title: "Payables & statements",
  description: "What V360 owes each brand now (delivered orders not on a statement) and the statements issued or paid, with their order lines.",
  filters: ["dateRange", "brand"],
  requires: ["money.view"],
  async run(f, ctx) {
    ctx.progress("Loading brand payables…");
    const [payables, settlements] = await Promise.all([
      fetchAll<BrandPayable>((from, to) => supabase.rpc("brand_payable_overview").order("brand_name").order("brand_id").range(from, to)),
      fetchAll<Settlement>((from, to) => {
        let q = supabase.from("settlements").select("*, brand:organizations(name), settlement_lines(*)");
        if (f.brandId) q = q.eq("brand_id", f.brandId);
        return q.order("id").range(from, to);
      }, (n) => ctx.progress(`Loading statements… ${n.toLocaleString()}`)),
    ]);
    const pay = payables.filter((p) => !f.brandId || p.brand_id === f.brandId);
    const hasRange = !!(f.from || f.to);
    const stmts = settlements.filter((s) => !hasRange || within(s.created_at, f) || within(s.paid_at, f));
    const period = (s: Settlement) => (s.kind === "monthly" && s.period_start && s.period_end ? `${s.period_start} to ${s.period_end}` : "All outstanding");
    const stmtRows = stmts.map((s) => ({
      id: s.id, brand: s.brand?.name ?? "", kind: s.kind === "monthly" ? "Monthly" : "Pay now", period: period(s),
      status: s.status === "paid" ? "Paid" : "Issued", created_at: s.created_at, paid_at: s.paid_at,
      order_count: s.order_count, total_order_total: s.total_order_total, commission_pct: Number(s.commission_pct) / 100,
      total_commission: s.total_commission, total_freight: s.total_freight, total_payable: s.total_payable, note: s.note,
    }));
    const lineRows = stmts.flatMap((s) => (s.settlement_lines ?? []).map((l: SettlementLine) => ({
      ...l, statement_id: s.id, brand: s.brand?.name ?? "", status: s.status === "paid" ? "Paid" : "Issued",
    })));
    const issued = stmts.filter((s) => s.status === "issued");
    const paid = stmts.filter((s) => s.status === "paid");
    const byBrand = [...groupBy(stmts, (s) => s.brand?.name ?? "")].map(([b, ss]) => ({
      brand: b, statements: ss.length,
      issued: sum(ss.filter((s) => s.status === "issued").map((s) => s.total_payable)),
      paid: sum(ss.filter((s) => s.status === "paid").map((s) => s.total_payable)),
    }));
    return {
      title: "Payables & statements",
      filters: filterLines(f),
      notes: ["Outstanding payables are as of today (the date range applies to statements: created or paid in the range)."],
      figures: [
        fig("Outstanding payable now (PKR)", sum(pay.map((p) => p.payable_sum)), "money", true),
        fig("Orders not on a statement", sum(pay.map((p) => p.order_count))),
        fig("Statements", stmts.length),
        fig("Issued, not paid (PKR)", sum(issued.map((s) => s.total_payable)), "money", true),
        fig("Paid (PKR)", sum(paid.map((s) => s.total_payable)), "money", true),
      ],
      breakdowns: [{
        name: "Statements by brand",
        columns: [{ header: "Brand", key: "brand" }, { header: "Statements", key: "statements", type: "number" }, money("Issued (PKR)", "issued"), money("Paid (PKR)", "paid")],
        rows: byBrand,
      }],
      sheets: [
        {
          name: "Outstanding payables",
          columns: [
            { header: "Brand", key: "brand_name" }, { header: "Orders", key: "order_count", type: "number" },
            money("Order total", "order_total_sum"), money("Commission", "commission_sum"), money("Freight", "freight_sum"), money("Payable", "payable_sum"),
          ],
          rows: pay as unknown as Row[],
        },
        {
          name: "Statements",
          columns: [
            { header: "Statement #", key: "id", type: "number", width: 11 }, { header: "Brand", key: "brand" }, { header: "Kind", key: "kind", width: 10 },
            { header: "Period", key: "period", width: 24 }, { header: "Status", key: "status", width: 9 },
            { header: "Created", key: "created_at", type: "datetime" }, { header: "Paid", key: "paid_at", type: "datetime" },
            { header: "Orders", key: "order_count", type: "number" }, money("Order total", "total_order_total"),
            { header: "Commission %", key: "commission_pct", type: "percent" }, money("Commission", "total_commission"),
            money("Freight", "total_freight"), money("Payable", "total_payable"), { header: "Note", key: "note", width: 30 },
          ],
          rows: stmtRows,
        },
        {
          name: "Statement lines",
          columns: [
            { header: "Statement #", key: "statement_id", type: "number", width: 11 }, { header: "Brand", key: "brand" }, { header: "Status", key: "status", width: 9 },
            { header: "Order", key: "order_number", width: 14 }, { header: "Delivered", key: "delivered_at", type: "datetime" },
            money("Order total", "order_total"), money("Commission", "commission"), money("Freight share (PKR)", "freight_share_pkr"),
            decimal("Freight FX rate", "freight_fx_rate"), { header: "FX rate date", key: "freight_rate_date", type: "date" },
            money("Brand payable", "brand_payable"),
          ],
          rows: lineRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- V23 KBB account ledger

const KBB_KIND: Record<KbbPaymentKind, string> = { dispatch_advance: "Dispatch advance", delivery_balance: "Delivery payment", credit: "Credit / refund" };

const kbbLedger: ReportDef = {
  code: "V23", perm: "reports.kbb_ledger", side: "v360", category: "Finance",
  title: "KBB account ledger",
  description: "KBB's account per order and shipment (advances and delivery payments owed and paid, credits, net balance) plus every payment, with running totals.",
  filters: ["dateRange"],
  requires: ["money.view"],
  async run(f, ctx) {
    ctx.progress("Loading KBB account…");
    const [account, payments] = await Promise.all([
      fetchAll<KbbOrderAccount>((from, to) => supabase.rpc("kbb_account_overview").order("order_date").order("order_id").range(from, to),
        (n) => ctx.progress(`Loading KBB account… ${n.toLocaleString()}`)),
      fetchAll<KbbPayment>((from, to) => inRange(supabase.from("kbb_payments").select("*, shipment:shipments(code), order:orders(order_number)"), "payment_date", f)
        .order("payment_date").order("id").range(from, to), (n) => ctx.progress(`Loading payments… ${n.toLocaleString()}`)),
    ]);
    const orders = account.filter((r) => !(f.from || f.to) || within(r.order_date, f))
      .sort((a, b) => (a.order_date < b.order_date ? -1 : a.order_date > b.order_date ? 1 : 0));
    let run = 0;
    const orderRows = orders.map((r) => { run += Number(r.net_balance) || 0; return { ...r, running: run }; });
    let paidRun = 0;
    const payRows = payments.map((p) => {
      paidRun += Number(p.amount_pkr) || 0;
      return { ...p, kind_label: KBB_KIND[p.kind] ?? p.kind, against: p.shipment?.code ?? p.order?.order_number ?? "", running: paidRun };
    });
    const byShipment = [...groupBy(orders, (r) => r.shipment_code ?? "")].map(([code, rs]) => ({
      shipment_code: code, shipment_status: rs[0]?.shipment_status ?? "", orders: rs.length,
      order_value_pkr: sum(rs.map((r) => r.order_value_pkr)),
      advance_owed: sum(rs.map((r) => r.advance_owed)), advance_paid: sum(rs.map((r) => r.advance_paid)),
      delivery_owed: sum(rs.map((r) => r.delivery_owed)), delivery_paid: sum(rs.map((r) => r.delivery_paid)),
      credits: sum(rs.map((r) => r.credits)), net_balance: sum(rs.map((r) => r.net_balance)),
    }));
    const acctCols: Column[] = [
      money("Order value", "order_value_pkr"), money("Advance owed", "advance_owed"), money("Advance paid", "advance_paid"),
      money("Delivery owed", "delivery_owed"), money("Delivery paid", "delivery_paid"), money("Credits", "credits"), money("Net balance", "net_balance"),
    ];
    const byKind = [...groupBy(payments, (p) => KBB_KIND[p.kind] ?? p.kind)].map(([k, ps]) => ({ kind: k, payments: ps.length, amount_pkr: sum(ps.map((p) => p.amount_pkr)) }));
    return {
      title: "KBB account ledger",
      filters: filterLines(f),
      notes: [
        "Net balance: positive = KBB still to pay V360, as on the Money page's KBB account tab.",
        "Date range: orders by order date, payments by payment date. Running balance = cumulative net balance in order-date order.",
      ],
      figures: [
        fig("Orders", orders.length),
        fig("Total outstanding (PKR)", sum(orders.map((r) => r.net_balance)), "money", true),
        fig("Orders with a balance", orders.filter((r) => Number(r.net_balance) !== 0).length),
        fig("Advance owed (PKR)", sum(orders.map((r) => r.advance_owed)), "money", true),
        fig("Delivery owed (PKR)", sum(orders.map((r) => r.delivery_owed)), "money", true),
        fig("Payments", payments.length),
        fig("Payments received (PKR)", sum(payments.map((p) => p.amount_pkr)), "money", true),
      ],
      breakdowns: [{
        name: "Payments by type",
        columns: [{ header: "Type", key: "kind" }, { header: "Payments", key: "payments", type: "number" }, money("Amount (PKR)", "amount_pkr")],
        rows: byKind,
      }],
      sheets: [
        {
          name: "By order",
          columns: [
            { header: "Order", key: "order_number", width: 14 }, { header: "Ordered", key: "order_date", type: "datetime" },
            { header: "Shipment", key: "shipment_code", width: 12 }, { header: "Shipment status", key: "shipment_status", width: 16 },
            ...acctCols, money("Running balance", "running"),
          ],
          rows: orderRows,
        },
        {
          name: "By shipment",
          columns: [
            { header: "Shipment", key: "shipment_code", width: 12 }, { header: "Shipment status", key: "shipment_status", width: 16 },
            { header: "Orders", key: "orders", type: "number" }, ...acctCols,
          ],
          rows: byShipment,
        },
        {
          name: "Payments",
          columns: [
            { header: "Date", key: "payment_date", type: "date" }, { header: "Type", key: "kind_label", width: 16 },
            { header: "Against", key: "against", width: 14 }, money("Amount", "amount"), { header: "Currency", key: "currency", width: 9, money: true },
            decimal("FX rate", "fx_rate"), money("Amount (PKR)", "amount_pkr"), money("Running total (PKR)", "running"),
            { header: "Note", key: "note", width: 30 }, { header: "Recorded", key: "created_at", type: "datetime" },
          ],
          rows: payRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- V24 Shipping charges

const shippingCharges: ReportDef = {
  code: "V24", perm: "reports.shipping_charges", side: "v360", category: "Finance",
  title: "Shipping charges",
  description: "Brand shipping-charges invoices per shipment: weight, BDT/kg rate, FX, PKR amount and payment status, with their order lines.",
  filters: ["dateRange", "brand", "shipment"],
  requires: ["invoices.view"],
  async run(f, ctx) {
    const invs = await loadShippingInvoices(f, ctx.progress, true);
    const lines: BrandShippingInvoiceLine[] = [];
    for (const ids of chunk(invs.map((i) => i.id))) {
      const rows = await fetchAll<BrandShippingInvoiceLine>((from, to) =>
        supabase.from("brand_shipping_invoice_lines").select("*").in("invoice_id", ids).order("id").range(from, to));
      lines.push(...rows);
      ctx.progress(`Loading invoice lines… ${lines.length.toLocaleString()}`);
    }
    const byId = new Map(invs.map((i) => [i.id, i]));
    const invRows = invs.map((i) => ({
      ...i, brand_name: i.brand?.name ?? "", shipment_code: i.shipment?.code ?? "", shipping_partner: i.shipment?.shipping_partner ?? "",
      dispatched_at: i.shipment?.dispatched_at ?? null, payment_label: payLabel(i.payment_status),
    }));
    const lineRows = lines.map((l) => {
      const i = byId.get(l.invoice_id);
      return { ...l, invoice_number: i?.invoice_number ?? "", brand_name: i?.brand?.name ?? "", shipment_code: i?.shipment?.code ?? "" };
    }).sort((a, b) => a.invoice_number.localeCompare(b.invoice_number) || a.order_number.localeCompare(b.order_number));
    const byBrand = [...groupBy(invs, (i) => i.brand?.name ?? "")].map(([b, is]) => ({
      brand: b, invoices: is.length, weight: sum(is.map((i) => i.weight_kg)), amount: sum(is.map((i) => i.amount_pkr)),
      unpaid: sum(is.filter((i) => i.payment_status !== "paid").map((i) => i.amount_pkr)),
    }));
    const byStatus = [...groupBy(invs, (i) => payLabel(i.payment_status))].map(([s, is]) => ({ status: s, invoices: is.length, amount: sum(is.map((i) => i.amount_pkr)) }));
    return {
      title: "Shipping charges",
      filters: filterLines(f),
      figures: [
        fig("Invoices", invs.length),
        fig("Orders", sum(invs.map((i) => i.order_count))),
        fig("Pakistan units", sum(invs.map((i) => i.pk_units))),
        fig("Weight (kg)", Math.round(sum(invs.map((i) => i.weight_kg)) * 100) / 100, "money"),
        fig("Amount (PKR)", sum(invs.map((i) => i.amount_pkr)), "money", true),
        fig("Unpaid (PKR)", sum(invs.filter((i) => i.payment_status !== "paid").map((i) => i.amount_pkr)), "money", true),
      ],
      breakdowns: [
        { name: "By brand", columns: [{ header: "Brand", key: "brand" }, { header: "Invoices", key: "invoices", type: "number" }, decimal("Weight (kg)", "weight"), money("Amount (PKR)", "amount"), money("Unpaid (PKR)", "unpaid")], rows: byBrand },
        { name: "By payment status", columns: [{ header: "Status", key: "status" }, { header: "Invoices", key: "invoices", type: "number" }, money("Amount (PKR)", "amount")], rows: byStatus },
      ],
      sheets: [
        {
          name: "Invoices",
          columns: [
            { header: "Invoice", key: "invoice_number", width: 22 }, { header: "Date", key: "created_at", type: "date" },
            { header: "Shipment", key: "shipment_code", width: 12 }, { header: "Carrier", key: "shipping_partner", width: 14 },
            { header: "Dispatched", key: "dispatched_at", type: "date" }, { header: "Brand", key: "brand_name" },
            { header: "Orders", key: "order_count", type: "number" }, { header: "PK units", key: "pk_units", type: "number" },
            { header: "BD units", key: "bd_units", type: "number" }, decimal("Weight (kg)", "weight_kg"),
            money("Rate (BDT/kg)", "freight_bdt_per_kg"), decimal("FX rate", "fx_rate"), { header: "FX date", key: "fx_rate_date", type: "date" },
            money("Amount (PKR)", "amount_pkr"), { header: "Payment status", key: "payment_label", width: 15 },
            { header: "Paid", key: "paid_at", type: "date" },
          ],
          rows: invRows,
        },
        {
          name: "Invoice lines",
          columns: [
            { header: "Invoice", key: "invoice_number", width: 22 }, { header: "Shipment", key: "shipment_code", width: 12 },
            { header: "Brand", key: "brand_name" }, { header: "Order", key: "order_number", width: 14 },
            { header: "Customer", key: "customer_name" }, { header: "Items", key: "items_summary", width: 40 },
            { header: "PK units", key: "pk_units", type: "number" }, { header: "BD units", key: "bd_units", type: "number" },
            decimal("Weight (kg)", "weight_kg"), money("Amount (PKR)", "amount_pkr"),
          ],
          rows: lineRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- V25 Commissions

/** Commission % per brand: brand_money_settings, else the global money settings, else 8% / 15% (as the portal does). */
async function loadCommissionPcts(): Promise<{ kbb: (brandId: string) => number; v360: (brandId: string) => number }> {
  const [{ data: rows, error }, { data: global }] = await Promise.all([
    supabase.from("brand_money_settings").select("brand_id, kbb_commission_pct, v360_commission_pct"),
    supabase.rpc("my_money_settings"),
  ]);
  if (error) throw error;
  const g = (global ?? {}) as MoneySettings;
  const kbbDefault = Number(g.kbb_commission_pct ?? 8);
  const v360Default = Number(g.v360_commission_pct ?? 15);
  const byBrand = new Map<string, { kbb: number; v360: number }>();
  for (const r of (rows ?? []) as { brand_id: string; kbb_commission_pct: number | null; v360_commission_pct: number | null }[]) {
    byBrand.set(r.brand_id, {
      kbb: r.kbb_commission_pct === null ? kbbDefault : Number(r.kbb_commission_pct),
      v360: r.v360_commission_pct === null ? v360Default : Number(r.v360_commission_pct),
    });
  }
  return { kbb: (b) => byBrand.get(b)?.kbb ?? kbbDefault, v360: (b) => byBrand.get(b)?.v360 ?? v360Default };
}

const commissions: ReportDef = {
  code: "V25", perm: "reports.commissions", side: "v360", category: "Finance",
  title: "Commissions",
  description: "Per brand per month: delivered order value, V360 commission and KBB commission, using each brand's commission rates.",
  filters: ["dateRange", "brand"],
  requires: ["money.view"],
  async run(f, ctx) {
    const [all, pcts] = await Promise.all([loadOrders({ ...f, status: null }, ctx.progress, "delivered_at"), loadCommissionPcts()]);
    const delivered = all.filter((o) => o.status === "delivered" && o.delivered_at);
    const fullPkr = await loadFullValuesPkr(delivered.map((o) => o.id), ctx.progress);
    const orderRows = delivered.map((o) => {
      const value = fullPkr.get(o.id) ?? 0;
      const kp = pcts.kbb(o.brand_id), vp = pcts.v360(o.brand_id);
      return {
        order_number: o.order_number, order_date: o.order_date, delivered_at: o.delivered_at, month: monthKey(o.delivered_at),
        brand_name: o.brand_name, brand_id: o.brand_id, city: o.city, value,
        v360_pct: vp / 100, v360: (value * vp) / 100, kbb_pct: kp / 100, kbb: (value * kp) / 100,
      };
    });
    const monthly = [...groupBy(orderRows, (r) => `${r.month}|${r.brand_name}`)].map(([, rs]) => ({
      month: rs[0].month, brand_name: rs[0].brand_name, orders: rs.length, value: sum(rs.map((r) => r.value)),
      v360_pct: rs[0].v360_pct, v360: sum(rs.map((r) => r.v360)), kbb_pct: rs[0].kbb_pct, kbb: sum(rs.map((r) => r.kbb)),
    })).sort((a, b) => a.month.localeCompare(b.month) || a.brand_name.localeCompare(b.brand_name));
    const byMonth = [...groupBy(orderRows, (r) => r.month)].map(([m, rs]) => ({
      month: m, orders: rs.length, value: sum(rs.map((r) => r.value)), v360: sum(rs.map((r) => r.v360)), kbb: sum(rs.map((r) => r.kbb)),
    })).sort((a, b) => a.month.localeCompare(b.month));
    const byBrand = [...groupBy(orderRows, (r) => r.brand_name)].map(([b, rs]) => ({
      brand: b, orders: rs.length, value: sum(rs.map((r) => r.value)), v360_pct: rs[0].v360_pct, v360: sum(rs.map((r) => r.v360)),
      kbb_pct: rs[0].kbb_pct, kbb: sum(rs.map((r) => r.kbb)),
    })).sort((a, b) => b.value - a.value);
    const valueCols: Column[] = [{ header: "Orders", key: "orders", type: "number" }, money("Delivered value", "value"), money("V360 commission", "v360"), money("KBB commission", "kbb")];
    return {
      title: "Commissions",
      filters: filterLines(f),
      notes: [
        "Delivered orders, by delivery date. Order value = the full order value in PKR, including orders paid online (FX rate of the order date).",
        "Commission % = the brand's own setting, else the global money setting. Current rates are applied to past months.",
      ],
      figures: [
        fig("Delivered orders", orderRows.length),
        fig("Delivered value", sum(orderRows.map((r) => r.value)), "money", true),
        fig("V360 commission", sum(orderRows.map((r) => r.v360)), "money", true),
        fig("KBB commission", sum(orderRows.map((r) => r.kbb)), "money", true),
      ],
      breakdowns: [
        { name: "By month", columns: [{ header: "Month", key: "month", width: 10 }, ...valueCols], rows: byMonth },
        {
          name: "By brand",
          columns: [{ header: "Brand", key: "brand" }, { header: "Orders", key: "orders", type: "number" }, money("Delivered value", "value"),
            { header: "V360 %", key: "v360_pct", type: "percent" }, money("V360 commission", "v360"),
            { header: "KBB %", key: "kbb_pct", type: "percent" }, money("KBB commission", "kbb")],
          rows: byBrand,
        },
      ],
      sheets: [
        {
          name: "By brand and month",
          columns: [{ header: "Month", key: "month", width: 10 }, { header: "Brand", key: "brand_name" }, { header: "Orders", key: "orders", type: "number" },
            money("Delivered value", "value"), { header: "V360 %", key: "v360_pct", type: "percent" }, money("V360 commission", "v360"),
            { header: "KBB %", key: "kbb_pct", type: "percent" }, money("KBB commission", "kbb")],
          rows: monthly,
        },
        {
          name: "Orders",
          columns: [{ header: "Order", key: "order_number", width: 14 }, { header: "Order date", key: "order_date", type: "datetime" },
            { header: "Delivered", key: "delivered_at", type: "datetime" }, { header: "Brand", key: "brand_name" }, { header: "City", key: "city", width: 16 },
            money("Order value", "value"), { header: "V360 %", key: "v360_pct", type: "percent" }, money("V360 commission", "v360"),
            { header: "KBB %", key: "kbb_pct", type: "percent" }, money("KBB commission", "kbb")],
          rows: orderRows,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- V26 Revenue / GMV

type Outcome = "delivered" | "returned" | "cancelled" | "open";
const outcomeOf = (s: OrderStatus): Outcome => (s === "delivered" ? "delivered" : s === "returned" ? "returned" : s === "cancelled" ? "cancelled" : "open");

function gmvRow(os: OrderOverview[]): Row & { value: number } {
  const r: Row & { value: number } = { orders: os.length, value: sum(os.map((o) => o.order_total)) };
  for (const k of ["delivered", "returned", "cancelled", "open"] as Outcome[]) {
    const g = os.filter((o) => outcomeOf(o.status) === k);
    r[`${k}_n`] = g.length;
    r[`${k}_v`] = sum(g.map((o) => o.order_total));
  }
  r.delivered_pct = ratio(Number(r.delivered_v), Number(r.value));
  return r;
}
const GMV_COLS: Column[] = [
  { header: "Orders", key: "orders", type: "number" }, money("Order value (GMV)", "value", 16),
  { header: "Delivered", key: "delivered_n", type: "number" }, money("Delivered value", "delivered_v"),
  { header: "Returned", key: "returned_n", type: "number" }, money("Returned value", "returned_v"),
  { header: "Cancelled", key: "cancelled_n", type: "number" }, money("Cancelled value", "cancelled_v"),
  { header: "In progress", key: "open_n", type: "number" }, money("In-progress value", "open_v"),
  { header: "Delivered % of value", key: "delivered_pct", type: "percent" },
];

const revenue: ReportDef = {
  code: "V26", perm: "reports.revenue", side: "v360", category: "Finance",
  title: "Revenue / GMV",
  description: "Order value by month, brand and city, split into delivered, returned, cancelled and still in progress.",
  filters: ["dateRange", "brand"],
  requires: ["orders.view_money"],
  async run(f, ctx) {
    const orders = await loadOrders({ ...f, status: null }, ctx.progress);
    const byMonth = [...groupBy(orders, (o) => monthKey(o.order_date))].map(([m, os]) => ({ month: m, ...gmvRow(os) })).sort((a, b) => a.month.localeCompare(b.month));
    const byBrand = [...groupBy(orders, (o) => o.brand_name)].map(([b, os]) => ({ brand: b, ...gmvRow(os) })).sort((a, b) => Number(b.value) - Number(a.value));
    const byCity = [...groupBy(orders, (o) => (o.city ?? "").trim() || "Unknown")].map(([c, os]) => ({ city: c, ...gmvRow(os) })).sort((a, b) => Number(b.value) - Number(a.value));
    const byMonthBrand = [...groupBy(orders, (o) => `${monthKey(o.order_date)}|${o.brand_name}`)].map(([, os]) => ({ month: monthKey(os[0].order_date), brand: os[0].brand_name, ...gmvRow(os) }))
      .sort((a, b) => a.month.localeCompare(b.month) || a.brand.localeCompare(b.brand));
    const currencies = [...new Set(orders.map((o) => o.currency).filter(Boolean))];
    const t = gmvRow(orders);
    return {
      title: "Revenue / GMV",
      filters: filterLines(f),
      notes: [`Orders by order date. Value = order total${currencies.length ? ` (${currencies.join(", ")})` : ""}.`],
      figures: [
        fig("Orders", orders.length),
        fig("Order value (GMV)", Number(t.value), "money", true),
        fig("Delivered value", Number(t.delivered_v), "money", true),
        fig("Returned value", Number(t.returned_v), "money", true),
        fig("Cancelled value", Number(t.cancelled_v), "money", true),
        fig("Delivered % of value", t.delivered_pct as number | null, "percent", true),
      ],
      breakdowns: [{ name: "By month", columns: [{ header: "Month", key: "month", width: 10 }, ...GMV_COLS], rows: byMonth }],
      sheets: [
        { name: "By brand", columns: [{ header: "Brand", key: "brand" }, ...GMV_COLS], rows: byBrand },
        { name: "By city", columns: [{ header: "City", key: "city" }, ...GMV_COLS], rows: byCity },
        { name: "By month and brand", columns: [{ header: "Month", key: "month", width: 10 }, { header: "Brand", key: "brand" }, ...GMV_COLS], rows: byMonthBrand },
      ],
    };
  },
};

// ---------------------------------------------------------------- V27 FX rate history

const fxHistory: ReportDef = {
  code: "V27", perm: "reports.fx_history", side: "v360", category: "Finance",
  title: "FX rate history",
  description: "Every FX rate entered, by rate date.",
  filters: ["dateRange"],
  async run(f, ctx) {
    const rates = await fetchAll<FxRate>((from, to) => inRange(supabase.from("fx_rates").select("*"), "rate_date", f)
      .order("rate_date").order("id").range(from, to), (n) => ctx.progress(`Loading FX rates… ${n.toLocaleString()}`));
    const rows = rates.map((r) => ({ ...r, pair: `${r.base}/${r.quote}` }));
    const byPair = [...groupBy(rows, (r) => r.pair)].map(([p, rs]) => {
      const vals = rs.map((r) => Number(r.rate));
      const last = rs[rs.length - 1];
      return { pair: p, rates: rs.length, first: rs[0].rate_date, last: last.rate_date, latest: last.rate, min: Math.min(...vals), max: Math.max(...vals) };
    });
    return {
      title: "FX rate history",
      filters: filterLines(f),
      figures: [fig("Rates", rows.length), fig("Currency pairs", byPair.length)],
      breakdowns: [{
        name: "By currency pair",
        columns: [{ header: "Pair", key: "pair", width: 10 }, { header: "Rates", key: "rates", type: "number" },
          { header: "First date", key: "first", type: "date" }, { header: "Last date", key: "last", type: "date" },
          decimal("Latest", "latest"), decimal("Lowest", "min"), decimal("Highest", "max")],
        rows: byPair,
      }],
      sheets: [{
        name: "Rates",
        columns: [{ header: "Rate date", key: "rate_date", type: "date" }, { header: "Base", key: "base", width: 8 }, { header: "Quote", key: "quote", width: 8 },
          { header: "Rate", key: "rate", type: "money", width: 12 }, { header: "Note", key: "note", width: 30 }, { header: "Entered", key: "created_at", type: "datetime" }],
        rows,
      }],
      notes: ["Rates are shown to 2 decimals; the cell holds the full rate."],
    };
  },
};

// ---------------------------------------------------------------- V28 Brand directory & scorecard

/** Statuses an order can only be in after it was confirmed. */
const PRE_CONFIRM = new Set<OrderStatus>(["new", "confirmation_pending", "customer_unreachable", "needs_amendment", "brand_confirmed", "cancelled", "hold"]);

async function loadBrands(): Promise<BrandRow[]> {
  return fetchAll<BrandRow>((from, to) => supabase.from("organizations")
    .select("id, name, type, slug, is_active, approval_status, review_note, created_at, contact_phone, reviewed_at, shopify_connections(shop_domain, status, last_synced_at)")
    .eq("type", "brand").order("created_at").order("id").range(from, to));
}
const connOf = (b: BrandRow) => (Array.isArray(b.shopify_connections) ? b.shopify_connections[0] : b.shopify_connections) ?? null;
const APPROVAL: Record<string, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected" };

const brandScorecard: ReportDef = {
  code: "V28", perm: "reports.brand_scorecard", side: "v360", category: "Platform",
  title: "Brand directory & scorecard",
  description: "Every brand with approval status, Shopify connection and last sync, plus its order performance in the date range.",
  filters: ["dateRange"],
  async run(f, ctx) {
    ctx.progress("Loading brands…");
    const brands = await loadBrands();
    const scope: ReportFilters = { ...f, brandId: null, status: null };
    const orders = await loadOrders(scope, ctx.progress);
    const confirmedAt = new Map<string, string | null>();
    const conf = await fetchAll<{ id: string; confirmed_at: string | null }>((from, to) =>
      inRange(supabase.from("orders").select("id, confirmed_at"), "order_date", scope).order("order_date").order("id").range(from, to),
    (n) => ctx.progress(`Loading confirmations… ${n.toLocaleString()}`));
    for (const c of conf) confirmedAt.set(c.id, c.confirmed_at);
    const isConfirmed = (o: OrderOverview) => !!confirmedAt.get(o.id) || !PRE_CONFIRM.has(o.status);
    const byBrand = groupBy(orders, (o) => o.brand_id);
    const rows = brands.map((b) => {
      const c = connOf(b);
      const os = byBrand.get(b.id) ?? [];
      const n = os.length;
      const delivered = os.filter((o) => o.status === "delivered");
      const days = delivered.map((o) => daysBetween(o.order_date, o.delivered_at)).filter((d): d is number => d !== null);
      return {
        name: b.name, approval: APPROVAL[b.approval_status] ?? b.approval_status, active: b.is_active ? "Yes" : "No",
        created_at: b.created_at, reviewed_at: b.reviewed_at, contact_phone: b.contact_phone,
        shop: c?.shop_domain ?? "", shop_status: c?.status ?? "Not connected", last_sync: c?.last_synced_at ?? null,
        orders: n, value: sum(os.map((o) => o.order_total)),
        confirmed_pct: ratio(os.filter(isConfirmed).length, n),
        cancelled_pct: ratio(os.filter((o) => o.status === "cancelled").length, n),
        delivered_pct: ratio(delivered.length, n),
        returned_pct: ratio(os.filter((o) => o.status === "returned").length, n),
        median_days: median(days),
      };
    }).sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
    const byApproval = [...groupBy(rows, (r) => r.approval)].map(([a, rs]) => ({ approval: a, brands: rs.length, active: rs.filter((r) => r.active === "Yes").length }));
    const allDays = orders.filter((o) => o.status === "delivered").map((o) => daysBetween(o.order_date, o.delivered_at)).filter((d): d is number => d !== null);
    return {
      title: "Brand directory & scorecard",
      filters: filterLines(f),
      notes: ["Performance = orders placed in the date range, by current status. Confirmed = was confirmed at some point (or is past confirmation)."],
      figures: [
        fig("Brands", brands.length),
        fig("Approved", rows.filter((r) => r.approval === "Approved").length),
        fig("Pending approval", rows.filter((r) => r.approval === "Pending").length),
        fig("Shopify connected", rows.filter((r) => r.shop).length),
        fig("Orders in range", orders.length),
        fig("Median days order → delivered", median(allDays), "days"),
      ],
      breakdowns: [{
        name: "By approval status",
        columns: [{ header: "Approval", key: "approval" }, { header: "Brands", key: "brands", type: "number" }, { header: "Active", key: "active", type: "number" }],
        rows: byApproval,
      }],
      sheets: [{
        name: "Brands",
        columns: [
          { header: "Brand", key: "name" }, { header: "Approval", key: "approval", width: 11 }, { header: "Active", key: "active", width: 8 },
          { header: "Created", key: "created_at", type: "date" }, { header: "Reviewed", key: "reviewed_at", type: "date" },
          { header: "Phone", key: "contact_phone", width: 16 }, { header: "Shopify shop", key: "shop", width: 28 },
          { header: "Shopify status", key: "shop_status", width: 14 }, { header: "Last sync", key: "last_sync", type: "datetime" },
          { header: "Orders", key: "orders", type: "number" }, money("Order value", "value"),
          { header: "Confirmed %", key: "confirmed_pct", type: "percent" }, { header: "Cancelled %", key: "cancelled_pct", type: "percent" },
          { header: "Delivered %", key: "delivered_pct", type: "percent" }, { header: "Returned %", key: "returned_pct", type: "percent" },
          { header: "Median days to deliver", key: "median_days", type: "days", width: 12 },
        ],
        rows,
      }],
    };
  },
};

// ---------------------------------------------------------------- V29 Shopify sync errors

const shopifySync: ReportDef = {
  code: "V29", perm: "reports.shopify_sync", side: "v360", category: "Platform",
  title: "Shopify sync errors",
  description: "Shopify webhooks received: which failed and why, which were processed, by topic and shop.",
  filters: ["dateRange"],
  async run(f, ctx) {
    const [events, brands] = await Promise.all([
      fetchAll<WebhookEvent>((from, to) => inRange(supabase.from("webhook_events").select("id, webhook_id, topic, shop_domain, received_at, processed_at, error"), "received_at", f)
        .order("received_at").order("id").range(from, to), (n) => ctx.progress(`Loading webhooks… ${n.toLocaleString()}`)),
      loadBrands(),
    ]);
    const brandOfShop = new Map<string, string>();
    for (const b of brands) { const c = connOf(b); if (c?.shop_domain) brandOfShop.set(c.shop_domain, b.name); }
    const result = (e: WebhookEvent) => (e.error ? "Error" : e.processed_at ? "Processed" : "Not processed");
    const rows = events.map((e) => ({
      ...e, brand: brandOfShop.get(e.shop_domain) ?? "", result: result(e),
      minutes: e.processed_at ? Math.round(((new Date(e.processed_at).getTime() - new Date(e.received_at).getTime()) / 60000) * 10) / 10 : null,
    }));
    const errors = rows.filter((r) => r.error);
    const tally = (rs: typeof rows) => ({ events: rs.length, errors: rs.filter((r) => r.result === "Error").length, processed: rs.filter((r) => r.result === "Processed").length, pending: rs.filter((r) => r.result === "Not processed").length });
    const byTopic = [...groupBy(rows, (r) => r.topic)].map(([t, rs]) => ({ topic: t, ...tally(rs), error_pct: ratio(rs.filter((r) => r.error).length, rs.length) })).sort((a, b) => b.errors - a.errors || b.events - a.events);
    const byShop = [...groupBy(rows, (r) => r.shop_domain)].map(([s, rs]) => ({ shop: s, brand: rs[0].brand, ...tally(rs), last_error: rs.filter((r) => r.error).pop()?.received_at ?? null })).sort((a, b) => b.errors - a.errors || b.events - a.events);
    const cols: Column[] = [
      { header: "Received", key: "received_at", type: "datetime" }, { header: "Topic", key: "topic", width: 20 },
      { header: "Shop", key: "shop_domain", width: 28 }, { header: "Brand", key: "brand" }, { header: "Result", key: "result", width: 13 },
      { header: "Processed", key: "processed_at", type: "datetime" }, { header: "Minutes to process", key: "minutes", type: "days", width: 11 },
      { header: "Error", key: "error", width: 60 }, { header: "Webhook id", key: "webhook_id", width: 24 },
    ];
    const t = tally(rows);
    return {
      title: "Shopify sync errors",
      filters: filterLines(f),
      figures: [fig("Webhooks received", t.events), fig("Errors", t.errors), fig("Processed", t.processed), fig("Not processed", t.pending), fig("Error rate", ratio(t.errors, t.events), "percent")],
      breakdowns: [
        { name: "By topic", columns: [{ header: "Topic", key: "topic" }, { header: "Events", key: "events", type: "number" }, { header: "Errors", key: "errors", type: "number" }, { header: "Processed", key: "processed", type: "number" }, { header: "Not processed", key: "pending", type: "number" }, { header: "Error rate", key: "error_pct", type: "percent" }], rows: byTopic },
        { name: "By shop", columns: [{ header: "Shop", key: "shop" }, { header: "Brand", key: "brand" }, { header: "Events", key: "events", type: "number" }, { header: "Errors", key: "errors", type: "number" }, { header: "Processed", key: "processed", type: "number" }, { header: "Not processed", key: "pending", type: "number" }, { header: "Last error", key: "last_error", type: "datetime" }], rows: byShop },
      ],
      sheets: [
        { name: "Errors", columns: cols, rows: errors },
        { name: "All webhooks", columns: cols, rows },
      ],
    };
  },
};

// ---------------------------------------------------------------- V30 Users & access

const BUILT_IN_LABEL: Record<string, string> = { v360: "V360 admin", partner: "KBB admin", brand: "Brand owner" };

const usersAccess: ReportDef = {
  code: "V30", perm: "reports.users_access", side: "v360", category: "Platform",
  title: "Users & access",
  description: "Every user with their organization and role, and which permissions each role grants.",
  filters: [],
  async run(_f, ctx) {
    ctx.progress("Loading users…");
    const [team, memberships, roles, catalog, orgs] = await Promise.all([
      fetchAll<Omit<TeamMember, "role_id">>((from, to) => supabase.from("team_members").select("*")
        .order("organization_type").order("organization_name").order("membership_id").range(from, to)),
      fetchAll<{ id: string; role_id: string | null }>((from, to) => supabase.from("memberships").select("id, role_id").order("id").range(from, to)),
      fetchAll<Omit<RoleRow, "member_count">>((from, to) => supabase.from("roles")
        .select("id, organization_id, org_type, name, description, is_preset, role_permissions(permission)").order("name").order("id").range(from, to)),
      fetchAll<PermissionDef>((from, to) => supabase.from("permissions").select("*").order("sort").order("key").range(from, to)),
      fetchAll<{ id: string; name: string; type: string }>((from, to) => supabase.from("organizations").select("id, name, type").order("type").order("name").order("id").range(from, to)),
    ]);
    const roleOf = new Map(memberships.map((m) => [m.id, m.role_id]));
    const roleById = new Map(roles.map((r) => [r.id, r]));
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const members = team.map((m) => ({ ...m, role_id: roleOf.get(m.membership_id) ?? null }));
    const counts = new Map<string, number>();
    for (const m of members) if (m.role_id) counts.set(m.role_id, (counts.get(m.role_id) ?? 0) + 1);

    const userRows = members.map((m) => {
      const builtIn = m.role === "admin" || m.role === "brand_owner";
      const role = builtIn
        ? BUILT_IN_LABEL[m.organization_type] ?? m.role
        : roleById.get(m.role_id ?? "")?.name ?? (m.organization_type === "brand" ? ROLE_LABEL[m.role] ?? m.role : "No role (no access)");
      return {
        full_name: m.full_name, email: m.email, phone: m.phone, organization_name: m.organization_name,
        type: ORG_TYPE_LABEL[m.organization_type] ?? m.organization_type, access: builtIn ? "Built-in admin (full access)" : "Custom role",
        role, created_at: m.created_at,
      };
    });

    const orgTypeOrder: Record<string, number> = { v360: 0, partner: 1, brand: 2 };
    const sortedRoles = [...roles].sort((a, b) => (orgTypeOrder[a.org_type] ?? 9) - (orgTypeOrder[b.org_type] ?? 9)
      || (orgName.get(a.organization_id) ?? "").localeCompare(orgName.get(b.organization_id) ?? "") || a.name.localeCompare(b.name));
    const granted = new Map(sortedRoles.map((r) => [r.id, new Set((r.role_permissions ?? []).map((p) => p.permission))]));
    const matrixRows = catalog.map((p) => {
      const r: Row = { area: p.area, label: p.label, key: p.key, applies: (p.applies_to ?? []).map((s) => ORG_TYPE_LABEL[s] ?? s).join(", ") };
      for (const role of sortedRoles) r[`r_${role.id}`] = granted.get(role.id)?.has(p.key) ? "Yes" : "";
      return r;
    });
    const roleRows = sortedRoles.map((r) => ({
      name: r.name, organization: orgName.get(r.organization_id) ?? "", type: ORG_TYPE_LABEL[r.org_type] ?? r.org_type,
      preset: r.is_preset ? "Yes" : "No", permissions: granted.get(r.id)?.size ?? 0, users: counts.get(r.id) ?? 0, description: r.description,
    }));
    const byType = [...groupBy(userRows, (u) => u.type)].map(([t, us]) => ({ type: t, users: us.length, admins: us.filter((u) => u.access.startsWith("Built-in")).length }));
    return {
      title: "Users & access",
      filters: [],
      notes: ["Only organizations, users and roles you are allowed to see are included."],
      figures: [fig("Users", userRows.length), fig("Built-in admins", userRows.filter((u) => u.access.startsWith("Built-in")).length), fig("Roles", roles.length), fig("Permissions", catalog.length)],
      breakdowns: [
        { name: "Users by organization type", columns: [{ header: "Type", key: "type" }, { header: "Users", key: "users", type: "number" }, { header: "Built-in admins", key: "admins", type: "number" }], rows: byType },
        {
          name: "Roles",
          columns: [{ header: "Role", key: "name" }, { header: "Organization", key: "organization" }, { header: "Type", key: "type" },
            { header: "Preset", key: "preset" }, { header: "Permissions", key: "permissions", type: "number" }, { header: "Users", key: "users", type: "number" }],
          rows: roleRows,
        },
      ],
      sheets: [
        {
          name: "Users",
          columns: [
            { header: "Name", key: "full_name" }, { header: "Email", key: "email", width: 30 }, { header: "Phone", key: "phone", width: 16 },
            { header: "Organization", key: "organization_name" }, { header: "Type", key: "type", width: 8 },
            { header: "Access", key: "access", width: 26 }, { header: "Role", key: "role", width: 22 }, { header: "Added", key: "created_at", type: "date" },
          ],
          rows: userRows,
        },
        {
          name: "Role permissions",
          columns: [
            { header: "Area", key: "area", width: 16 }, { header: "Permission", key: "label", width: 34 }, { header: "Key", key: "key", width: 28 },
            { header: "Applies to", key: "applies", width: 16 },
            ...sortedRoles.map((r): Column => ({ header: `${r.name} (${orgName.get(r.organization_id) ?? ORG_TYPE_LABEL[r.org_type] ?? ""})`, key: `r_${r.id}`, width: 14 })),
          ],
          rows: matrixRows,
        },
      ],
    };
  },
};

export const V360_FINANCE_REPORTS: ReportDef[] = [
  invoiceRegister, unpaidAgeing, brandPayables, kbbLedger, shippingCharges, commissions, revenue, fxHistory,
  brandScorecard, shopifySync, usersAccess,
];
