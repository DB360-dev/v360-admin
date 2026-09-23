import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, MessageCircle, MessageSquare, Phone } from "lucide-react";
import { useOrder, useOrderEvents, useOrderMessages } from "@/hooks/useData";
import { INBOUND_STATUS, RETURN_DISPOSITION, SHIPMENT_STATUS, STATUS } from "@/lib/status";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { Pill, StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";
import { JourneyRail } from "@/components/JourneyRail";
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

export function OrderDetail() {
  const { id = "" } = useParams();
  const q = useOrder(id);
  const ev = useOrderEvents(id);
  const msgs = useOrderMessages(id);
  const [tab, setTab] = useState<"timeline" | "messages">("timeline");

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
          <StatusBadge status={o.status} />
          {o.status === "hold" && o.previous_status && <span className="text-[13px] text-muted">paused at {STATUS[o.previous_status].label}</span>}
        </div>
        <p className="mt-1 text-[14px] text-muted">{o.brand?.name}, ordered {fmtDateTime(o.order_date)}</p>
      </header>

      <div className="panel mb-4 p-3"><OrderActions order={o} items={o.order_items} /></div>
      <div className="panel mb-6 px-3 py-5 sm:px-6"><JourneyRail status={o.status} previousStatus={o.previous_status} /></div>

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
            <Section title="Money">
              <Facts rows={[
                ["Order total", `${fmtMoney(o.order_total, o.currency)}${o.discount_total ? ` (after ${fmtMoney(o.discount_total, o.currency)} discount)` : ""}`],
                ["Payment", o.payment_status ?? "—"],
                ["COD to collect", <strong key="e">{fmtMoney(o.cod_amount_expected, cur)}</strong>],
                ["COD collected", o.cod_amount_collected !== null
                  ? <span key="c" className={short ? "font-semibold text-g-problem" : "font-medium"}>{fmtMoney(o.cod_amount_collected, cur)}{short ? " (differs)" : ""}</span>
                  : "Not yet"],
              ]} />
            </Section>
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
                ["Courier", o.delivery_courier], ["Tracking", o.delivery_tracking_number], ["Delivered", fmtDateTime(o.delivered_at)],
                ["Failure reason", o.failure_reason],
                ...(o.return_disposition ? [["Return decision", RETURN_DISPOSITION[o.return_disposition] ?? o.return_disposition] as [string, ReactNode]] : []),
              ]} />
            </Section>
          </div>
        </div>
        <aside className="xl:sticky xl:top-6 xl:self-start">
          <section className="panel">
            {/* Tab bar */}
            <div className="flex border-b border-line">
              {(["timeline", "messages"] as const).map((t) => {
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
                    {t === "timeline" ? "Timeline" : "Messages"}
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
