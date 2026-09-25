import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, MessageCircle, MessageSquare, Phone } from "lucide-react";
import { useShopifyFulfill, useBrandMoneySettings, useInvoicesList, useMoneySettings, useOrder, useOrderEvents, useOrderInternalNote, useOrderMessages, useSaveOrderInternalNote, useShipments } from "@/hooks/useData";
import { INBOUND_STATUS, PARTNER_STATUS_TRACK, RETURN_DISPOSITION, SHIPMENT_STATUS, STATUS, V360_STATUS_TRACK } from "@/lib/status";
import { useOps } from "@/context/OpsContext";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import type { InvoicePaymentStatus, OrderNoteRole, OpsOrderDetail } from "@/lib/types";
import { Pill, StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";
import { StatusRail } from "@/components/StatusRail";
import { Timeline } from "@/components/Timeline";
import { OrderMessages } from "@/components/OrderMessages";
import { OrderActions } from "@/components/OrderActions";

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5"><h2>{title}</h2>{aside}</div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-2 text-[13.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words">{v ?? "—"}</dd></div>
      ))}
    </dl>
  );
}

/** "+880 1711-000000" -> "8801711000000" for WhatsApp links. */
export const waNumber = (phone: string) => phone.replace(/\D/g, "");

export function ContactLinks({ phone }: { phone: string | null }) {
  if (!phone) return <span>—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="link inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{phone}</a>
      <a href={`https://wa.me/${waNumber(phone)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
        <MessageCircle className="h-3.5 w-3.5" />WhatsApp
      </a>
    </span>
  );
}

function InvoiceStatusPill({ status }: { status: InvoicePaymentStatus }) {
  const map: Record<InvoicePaymentStatus, { cls: string; label: string }> = {
    paid: { cls: "bg-emerald-100 text-emerald-800", label: "Paid" },
    partially_paid: { cls: "bg-amber-100 text-amber-800", label: "Partially paid" },
    not_paid: { cls: "bg-rose-100 text-rose-800", label: "Unpaid" },
  };
  const m = map[status];
  return <span className={`ml-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${m.cls}`}>{m.label}</span>;
}

/** Invoice-driven money view. Rows only appear once the matching invoice has been generated. */
function MoneyDetail({ order }: { order: OpsOrderDetail }) {
  const invQ = useInvoicesList();
  const shipmentsQ = useShipments("all");
  const brandSettings = useBrandMoneySettings(order.brand_id);
  const money = useMoneySettings();
  const kbbPct = brandSettings.data?.kbb_commission_pct ?? money.data?.kbb_commission_pct ?? 8;
  const v360Pct = brandSettings.data?.v360_commission_pct ?? money.data?.v360_commission_pct ?? 15;

  const allInvoices = invQ.data ?? [];
  const shipment = shipmentsQ.data?.find((s) => s.id === order.shipment_id) ?? null;
  const matches = (i: { order_ids?: string[] | null; shipment_ids?: string[] | null }) =>
    (i.order_ids?.includes(order.id) ?? false) ||
    (!!order.shipment_id && (i.shipment_ids?.includes(order.shipment_id) ?? false));

  const savedAdv = allInvoices.find((i) => i.invoice_type === "dispatch_advance" && matches(i));
  const savedSettle = allInvoices.find((i) => i.invoice_type === "final_settlement" && matches(i));

  // If no saved advance invoice yet, mirror the Invoices list fallback: a dispatched shipment
  // always carries INV-DISP-<code> with the shipment's payment status.
  const advanceInv = savedAdv
    ? savedAdv
    : shipment
    ? { invoice_number: `INV-DISP-${shipment.code}`, payment_status: shipment.invoice_payment_status || "not_paid" }
    : null;
  const settleInv = savedSettle ?? null;
  const cur = order.cod_currency ?? "BDT";

  const value = order.cod_amount_expected && order.cod_amount_expected > 0 ? order.cod_amount_expected : order.order_total ?? 0;
  const advance = value * 0.5;
  const kbbCommission = (value * kbbPct) / 100;
  const v360Commission = (value * v360Pct) / 100;
  const isReturned = ["returned", "delivery_failed", "hub_issue", "cancelled"].includes(order.status);
  const clawback = isReturned ? advance : 0;
  const settlement = value - advance - kbbCommission - clawback;

  if (invQ.isLoading || shipmentsQ.isLoading) return <p className="py-2 text-[13px] text-faint">Loading invoices…</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted">50% advance invoice</span>
        {advanceInv ? (
          <span className="font-medium">{advanceInv.invoice_number}<InvoiceStatusPill status={advanceInv.payment_status} /></span>
        ) : <span className="text-faint">Not generated</span>}
      </div>
      {advanceInv && (
        <div className="flex items-center justify-between gap-3 pl-4 text-[13px]">
          <span className="text-muted">50% advance</span>
          <span className="whitespace-nowrap font-medium">{fmtMoney(advance, cur)}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
        <span className="text-muted">Final settlement invoice</span>
        {settleInv ? (
          <span className="font-medium">{settleInv.invoice_number}<InvoiceStatusPill status={settleInv.payment_status} /></span>
        ) : <span className="text-faint">Not generated</span>}
      </div>
      {settleInv && (
        <div className="space-y-1 pl-4 text-[13px]">
          <div className="flex items-center justify-between gap-3"><span className="text-muted">Order value</span><span className="whitespace-nowrap">{fmtMoney(value, cur)}</span></div>
          <div className="flex items-center justify-between gap-3"><span className="text-muted">− 50% already paid</span><span className="whitespace-nowrap">−{fmtMoney(advance, cur)}</span></div>
          <div className="flex items-center justify-between gap-3"><span className="text-muted">− KBB commission ({kbbPct}%)</span><span className="whitespace-nowrap">−{fmtMoney(kbbCommission, cur)}</span></div>
          {isReturned && (
            <div className="flex items-center justify-between gap-3"><span className="text-muted">− 50% advance (returned, clawback)</span><span className="whitespace-nowrap">−{fmtMoney(clawback, cur)}</span></div>
          )}
          <div className="flex items-center justify-between gap-3 pt-1 font-semibold"><span>Settlement payable</span><span className="whitespace-nowrap">{fmtMoney(settlement, cur)}</span></div>
        </div>
      )}
      <div className="space-y-1 border-t border-line pt-2 text-[13px]">
        <div className="flex items-center justify-between gap-3"><span className="text-muted">KBB's commission ({kbbPct}%)</span><span className="whitespace-nowrap">{fmtMoney(kbbCommission, cur)}</span></div>
        <div className="flex items-center justify-between gap-3"><span className="text-muted">V360's commission ({v360Pct}%)</span><span className="whitespace-nowrap">{fmtMoney(v360Commission, cur)}</span></div>
      </div>
    </div>
  );
}

/** Role-scoped private note (order_internal_notes). Admins see the admin note;
 *  KBB partners see only the KBB note. Each role never sees the other's. */
function InternalNotes({ orderId, role }: { orderId: string; role: OrderNoteRole }) {
  const q = useOrderInternalNote(orderId, role);
  const save = useSaveOrderInternalNote(orderId, role, { inlineErrors: true });
  const [text, setText] = useState("");
  const loaded = useRef(false);

  useEffect(() => {
    if (q.data && !loaded.current) {
      setText(q.data.note ?? "");
      loaded.current = true;
    }
  }, [q.data]);

  const serverNote = q.data?.note ?? "";
  const dirty = serverNote !== text;

  if (q.isLoading) return <p className="py-2 text-[13.5px] text-faint">Loading note…</p>;

  return (
    <div className="space-y-2">
      <textarea
        className="input min-h-[96px] w-full resize-y text-[13.5px]"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={role === "admin" ? "Private note for admins only… (not shown to KBB)" : "Private note for KBB only… (not shown to admins)"}
        disabled={save.isPending}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-faint">
          {q.data?.updated_at ? `Saved ${fmtDateTime(q.data.updated_at)}` : "No note yet"}
          {dirty ? " · Unsaved changes" : ""}
          {save.isError ? " · Failed to save" : ""}
        </span>
        <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(text)}>
          Save note
        </Button>
      </div>
    </div>
  );
}

/** Result of pushing the delivery tracking to Shopify, with a retry. */
function ShopifyFulfillment({ order, canRetry }: { order: OpsOrderDetail; canRetry: boolean }) {
  const fulfill = useShopifyFulfill();
  const retry = canRetry && order.delivery_tracking_number && (
    <Button size="sm" variant="ghost" loading={fulfill.isPending} onClick={() => fulfill.mutate(order.id)}>
      {order.shopify_fulfillment_id ? "Resend tracking" : "Retry"}
    </Button>
  );
  if (order.shopify_fulfillment_error) {
    return <div><span className="text-g-problem">Not updated: {order.shopify_fulfillment_error}</span> {retry}</div>;
  }
  if (order.shopify_fulfillment_id) {
    return <div><span className="text-g-done">Fulfilled {fmtDateTime(order.shopify_fulfilled_at ?? null)}</span> {retry}</div>;
  }
  return <div><span className="text-muted">Not fulfilled yet</span> {retry}</div>;
}

export function OrderDetail() {
  const { id = "" } = useParams();
  const q = useOrder(id);
  const ev = useOrderEvents(id);
  const msgs = useOrderMessages(id);
  const { isV360, isAdmin, isKbb } = useOps();
  const [tab, setTab] = useState<"messages" | "timeline">("messages");

  if (q.isLoading) return <Spinner label="Loading order" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} title="This order didn't load" />;
  const o = q.data;
  if (!o) return <EmptyState title="Order not found" action={<Link to="/orders" className="link">All orders</Link>}>The link may be wrong, or you don't have access.</EmptyState>;

  const cur = o.cod_currency ?? "BDT";
  const hubSeen = !!o.received_at_hub_at || o.status === "hub_issue";
  const short = o.cod_amount_collected !== null && o.cod_amount_expected !== null && o.cod_amount_collected !== o.cod_amount_expected;

  return (
    <>
      <Link to="/orders" className="mb-4 inline-flex items-center gap-1.5 text-[13.5px] text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" /> All orders</Link>
      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1>{o.order_number}</h1>
          <StatusBadge status={o.status} discrepancy={o.returned_due_to_discrepancy} />
          {o.status === "hold" && o.previous_status && <span className="text-[13px] text-muted">paused at {STATUS[o.previous_status].label}</span>}
        </div>
        <p className="mt-1 text-[14px] text-muted">{o.brand?.name}, ordered {fmtDateTime(o.order_date)}</p>
      </header>

      <div className="panel mb-4 p-3"><OrderActions order={o} items={o.order_items} /></div>
      <div className="panel mb-6 px-3 py-5 sm:px-6"><StatusRail track={(isV360 ? V360_STATUS_TRACK : PARTNER_STATUS_TRACK)} status={o.status} events={ev.data ?? []} /></div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <Section title="Items">
            <div className="-m-4 overflow-x-auto">
              <table className="w-full min-w-[520px] text-[13.5px]">
                <thead className="table-head"><tr><th>Product</th><th>SKU</th><th className="text-right">Qty</th><th className="text-right">Price</th>{hubSeen && <th className="text-right">At hub</th>}</tr></thead>
                <tbody className="table-body">
                  {o.order_items.map((i) => (
                    <tr key={i.id}>
                      <td><div className="font-medium">{i.product_name}</div>{i.variant && <div className="text-[12.5px] text-muted">{i.variant}</div>}</td>
                      <td className="text-muted">{i.sku ?? "—"}</td>
                      <td className="text-right">{i.quantity}</td>
                      <td className="whitespace-nowrap text-right">{fmtMoney(i.unit_price, o.currency)}</td>
                      {hubSeen && <td className={`text-right font-medium ${i.received_quantity < i.quantity ? "text-g-problem" : "text-g-done"}`}>{i.received_quantity} of {i.quantity}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
            <Section title="Customer">
              <Facts rows={[
                ["Name", o.customer_name],
                ["Phone", <ContactLinks key="p" phone={o.customer_phone} />],
                ["Email", o.customer_email],
                ["Address", [o.address1, o.address2, o.city, o.province, o.zip].filter(Boolean).join(", ") || null],
                ["Customer note", o.customer_note],
                ["Shopify notes", o.shopify_note],
              ]} />
            </Section>
            {isV360 && (
              <Section title="Money">
                <Facts rows={[
                  ["Order total", `${fmtMoney(o.order_total, o.currency)}${o.discount_total ? ` (after ${fmtMoney(o.discount_total, o.currency)} discount)` : ""}`],
                  ["Payment", o.payment_status ?? "—"],
                  ["COD to collect", <strong key="e">{fmtMoney(o.cod_amount_expected, cur)}</strong>],
                  ["COD collected", o.cod_amount_collected !== null
                    ? <span key="c" className={short ? "font-semibold text-g-problem" : "font-medium"}>{fmtMoney(o.cod_amount_collected, cur)}{short ? " (differs)" : ""}</span>
                    : "Not yet"],
                ]} />
                <div className="mt-3 border-t border-line pt-3">
                  <MoneyDetail order={o} />
                </div>
              </Section>
            )}
            <Section title="Confirmation (KBB)">
              <Facts rows={[["Confirmed", fmtDateTime(o.confirmed_at)], ["Call attempts", o.confirmation_attempts || "—"]]} />
            </Section>
            <Section title="Brand confirmation">
              {o.brand_confirmed_at ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-g-done-bg">
                      <svg className="h-3 w-3 text-g-done" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="text-[13.5px] font-semibold text-g-done">Brand confirmed</span>
                  </div>
                  <p className="text-[12.5px] text-muted">{fmtDateTime(o.brand_confirmed_at)}</p>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-faint" />
                  <p className="text-[13.5px] text-muted">Not confirmed by brand yet</p>
                </div>
              )}
            </Section>
            <Section title="Brand dispatch to hub">
              {o.inbound_batch ? (
                <Facts rows={[
                  ["Courier", o.inbound_batch.courier], ["Tracking", o.inbound_batch.tracking_number], ["Sent", fmtDate(o.inbound_batch.dispatch_date)],
                  ["Parcel", <Pill key="b" {...INBOUND_STATUS[o.inbound_batch.status]} />],
                  ["Received at hub", fmtDateTime(o.received_at_hub_at)], ["Hub notes", o.hub_notes],
                ]} />
              ) : <p className="text-[13.5px] text-muted">Not dispatched by the brand yet.</p>}
            </Section>
            <Section title="Shipment to Bangladesh">
              {o.shipment ? (
                <Facts rows={[
                  ["Shipment", <Link key="s" to={`/shipments/${o.shipment.id}`} className="link font-medium">{o.shipment.code}</Link>],
                  ["Carrier", o.shipment.shipping_partner], ["Tracking", o.shipment.tracking_number],
                  ["Status", <Pill key="st" {...SHIPMENT_STATUS[o.shipment.status]} />], ["Left hub", fmtDateTime(o.shipment.dispatched_at)],
                  ["KBB received", fmtDateTime(o.shipment.received_at)],
                ]} />
              ) : <p className="text-[13.5px] text-muted">Not in a shipment yet.</p>}
            </Section>
            <Section title="Delivery (KBB)">
              <Facts rows={[
                ["Courier", o.delivery_courier], ["Tracking", o.delivery_tracking_number],
                ...(o.delivery_tracking_url ? [["Tracking link", <a key="tl" href={o.delivery_tracking_url} target="_blank" rel="noreferrer" className="link break-all">{o.delivery_tracking_url}</a>] as [string, ReactNode]] : []),
                ...((o.shopify_fulfillment_id || o.shopify_fulfillment_error || ["out_for_delivery", "delivered", "delivery_failed"].includes(o.status))
                  ? [["Shopify", <ShopifyFulfillment key="sf" order={o} canRetry={isV360 || isKbb} />] as [string, ReactNode]] : []),
                ...((o.shopify_payment_synced || o.shopify_payment_error) ? [["Shopify payment", o.shopify_payment_error
                  ? <span key="sp" className="text-g-problem">Not updated: {o.shopify_payment_error}</span>
                  : <span key="sp" className="text-g-done">{o.shopify_payment_synced === "paid" ? "Paid" : "Partially paid"} {fmtDateTime(o.shopify_payment_synced_at ?? null)}</span>] as [string, ReactNode]] : []),
                ["Delivered", fmtDateTime(o.delivered_at)],
                ["Failure reason", o.failure_reason],
                ...(o.return_disposition ? [["Return decision", RETURN_DISPOSITION[o.return_disposition] ?? o.return_disposition] as [string, ReactNode]] : []),
              ]} />
            </Section>
            {(isAdmin || isKbb) && (
              <Section
                title="Internal notes"
                aside={
                  <span className="rounded border border-line bg-sunken px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                    {isKbb ? "KBB only" : "admins only"}
                  </span>
                }
              >
                <InternalNotes orderId={o.id} role={isKbb ? "kbb" : "admin"} />
              </Section>
            )}
          </div>
        </div>
        <aside className="xl:sticky xl:top-6 xl:self-start">
          <section className="panel">
            {/* Tab bar */}
            <div className="flex border-b border-line">
              {(["messages", "timeline"] as const).map((t) => {
                const unread = t === "messages"
                  ? (msgs.data ?? []).filter((m) => m.sender_type === "brand" && !m.read_by_admin).length
                  : 0;
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`relative flex items-center gap-1.5 px-4 py-2.5 text-[13.5px] font-medium transition-colors ${
                      tab === t ? "border-b-2 border-primary text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {t === "messages" && <MessageSquare className="h-3.5 w-3.5" />}
                    {t === "messages" ? "Notes" : "Timeline"}
                    {unread > 0 && (
                      <span className="ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-fg">
                        {unread}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="p-4">
              {tab === "timeline"
                ? (ev.isLoading ? <Spinner /> : ev.isError ? <ErrorState error={ev.error} onRetry={() => ev.refetch()} /> : <Timeline events={ev.data!} />)
                : <OrderMessages orderId={id} brandName={o.brand?.name ?? "Brand"} />
              }
            </div>
          </section>
          <p className="mt-3 px-1 text-[12.5px] text-faint">Shopify order {o.shopify_order_id}{o.shopify_cancelled_at ? `, cancelled in Shopify ${fmtDateTime(o.shopify_cancelled_at)}` : ""}.</p>
        </aside>
      </div>
    </>
  );
}
