import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Inbox, Search, X } from "lucide-react";
import { PAGE_SIZE, useBrandOptions, useOrderList, useStatusCounts } from "@/hooks/useData";
import { ORDER_VIEWS, STATUS, type StatusGroup } from "@/lib/status";
import { fmtMoney, fmtShort, since } from "@/lib/format";
import type { OrderOverview, OrderStatus } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill, StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function invoicePaymentPill(o: OrderOverview): { label: string; group: StatusGroup } | null {
  if (!o.shipment_id) return null;
  const status = o.shipment_invoice_payment_status || "not_paid";
  switch (status) {
    case "paid":
      return { label: "Paid", group: "done" };
    case "partially_paid":
      return { label: "Partially paid", group: "kbb" };
    case "not_paid":
    default:
      return { label: "Unpaid", group: "problem" };
  }
}

export function where(o: OrderOverview): string {
  if (o.delivery_tracking_number) return `${o.delivery_courier ?? ""} ${o.delivery_tracking_number}`.trim();
  if (o.shipment_code) return `${o.shipment_code}${o.shipment_tracking ? `, ${o.shipment_tracking}` : ""}`;
  if (o.inbound_tracking) return `${o.inbound_courier ?? ""} ${o.inbound_tracking}`.trim();
  return "—";
}

export function fulfilmentStatus(o: OrderOverview): { label: string; group: StatusGroup } {
  switch (o.status) {
    case "new":
    case "confirmation_pending":
    case "customer_unreachable":
    case "needs_amendment":
      return { label: "New", group: "kbb" };
    case "brand_confirmed":
    case "confirmed":
    case "brand_preparing":
    case "dispatched_to_hub":
    case "received_at_hub":
    case "ready_for_shipment":
    case "assigned_to_shipment":
      return { label: "Confirmed by Fulfilment", group: "kbb" };
    case "shipped":
    case "in_transit":
    case "customs":
    case "arrived_bd":
      return { label: "In transit", group: "transit" };
    case "received_by_partner":
    case "preparing_for_delivery":
      return { label: "Preparing for delivery", group: "kbb" };
    case "out_for_delivery":
      return { label: "Out for delivery", group: "kbb" };
    case "delivered":
      return { label: "Delivered", group: "done" };
    case "delivery_failed":
      return { label: "Delivery failed", group: "problem" };
    case "returned":
      return { label: "Returned", group: "problem" };
    case "cancelled":
      return { label: "Cancelled", group: "closed" };
    case "hold":
      return { label: "On hold", group: "problem" };
    default:
      return { label: STATUS[o.status]?.label ?? o.status, group: STATUS[o.status]?.group ?? "closed" };
  }
}

export function brandStatus(o: OrderOverview): { label: string; group: StatusGroup } {
  switch (o.status) {
    case "new":
    case "confirmation_pending":
    case "customer_unreachable":
      return { label: "New", group: "kbb" };
    case "needs_amendment":
      return { label: "Needs amendment", group: "brand" };
    case "brand_confirmed":
      return { label: "Brand confirmed", group: "brand" };
    case "confirmed":
    case "brand_preparing":
    case "dispatched_to_hub":
    case "received_at_hub":
    case "ready_for_shipment":
    case "assigned_to_shipment":
    case "shipped":
    case "in_transit":
    case "customs":
    case "arrived_bd":
    case "received_by_partner":
    case "preparing_for_delivery":
    case "out_for_delivery":
      return { label: "Confirmed", group: "kbb" };
    case "delivered":
      return { label: "Delivered", group: "done" };
    case "cancelled":
      return { label: "Cancelled", group: "closed" };
    case "delivery_failed":
    case "returned":
      return { label: "Returned", group: "problem" };
    case "hold":
      return { label: "On hold", group: "problem" };
    default:
      return { label: STATUS[o.status]?.label ?? o.status, group: STATUS[o.status]?.group ?? "closed" };
  }
}

export function masterStatus(o: OrderOverview): { label: string; group: StatusGroup } {
  if (o.status === "confirmed") {
    return { label: "Fulfilment verified", group: "kbb" };
  }
  const s = STATUS[o.status];
  return { label: s?.label ?? o.status, group: s?.group ?? "closed" };
}

export function Orders() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const viewKey = params.get("view") ?? "all";
  const isStatusFilter = viewKey !== "all" && !ORDER_VIEWS.some((v) => v.key === viewKey) && viewKey in STATUS;
  const statusFilter: OrderStatus | null = isStatusFilter ? (viewKey as OrderStatus) : null;
  const view = statusFilter ? null : (ORDER_VIEWS.find((v) => v.key === viewKey) ?? ORDER_VIEWS[0]);
  const page = Math.max(0, Number(params.get("page") ?? 0) || 0);
  const brandId = params.get("brand") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const [searchInput, setSearchInput] = useState(params.get("q") ?? "");
  const search = useDebounced(searchInput);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, v] of Object.entries(patch)) { if (v) next.set(key, v); else next.delete(key); }
    if (!("page" in patch)) next.delete("page");
    setParams(next, { replace: true });
  };
  useEffect(() => { if (search !== (params.get("q") ?? "")) update({ q: search || null }); }, [search]); // eslint-disable-line

  const counts = useStatusCounts().data;
  const brands = useBrandOptions().data ?? [];
  const q = useOrderList({ statuses: statusFilter ? [statusFilter] : view!.statuses, brandId: brandId || undefined, search, from, to, page });
  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filters = !!(search || from || to || brandId);
  const count = (ss: OrderStatus[] | null) => counts ? (ss ?? Object.keys(counts) as (keyof typeof counts)[]).reduce((n, s) => n + (counts[s] ?? 0), 0) : null;

  return (
    <>
      <PageHeader title="All orders" description="Every brand's orders across the whole journey." />
      {statusFilter && (
        <div className="mb-3 flex items-center gap-2 text-[13px]">
          <span className="text-muted">Filtering by</span>
          <StatusBadge status={statusFilter} />
          <button onClick={() => update({ view: null })} className="font-medium text-muted underline decoration-dotted hover:text-ink">clear filter</button>
        </div>
      )}
      <div role="tablist" className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-line px-1">
        {ORDER_VIEWS.map((v) => {
          const n = count(v.statuses);
          return (
            <button key={v.key} role="tab" aria-selected={view ? v.key === view.key : false} onClick={() => update({ view: v.key === "all" ? null : v.key })}
              className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] ${view && v.key === view.key ? "border-primary font-medium" : "border-transparent text-muted hover:text-ink"}`}>
              {v.label}{n !== null && n > 0 && <span className={`rounded-full px-1.5 text-[12px] ${v.key === "problem" ? "bg-g-problem-bg font-semibold text-g-problem" : "bg-sunken text-muted"}`}>{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <span className="sr-only">Search</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <input className="input pl-9" placeholder="Order, customer, phone, city, brand" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </label>
        <label className="text-[12.5px] text-muted">Brand
          <select className="input mt-1 w-[180px]" value={brandId} onChange={(e) => update({ brand: e.target.value || null })}>
            <option value="">All brands</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="text-[12.5px] text-muted">From<input type="date" className="input mt-1 w-[150px]" value={from} onChange={(e) => update({ from: e.target.value || null })} /></label>
        <label className="text-[12.5px] text-muted">To<input type="date" className="input mt-1 w-[150px]" value={to} onChange={(e) => update({ to: e.target.value || null })} /></label>
        {filters && <Button variant="ghost" size="sm" onClick={() => { setSearchInput(""); update({ q: null, from: null, to: null, brand: null }); }}><X className="h-3.5 w-3.5" /> Clear</Button>}
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-[13.5px]">
            <thead className="table-head">
              <tr>
                <th>Order</th>
                <th>Brand</th>
                <th>Date</th>
                <th>Customer</th>
                <th className="text-right">COD</th>
                <th>Invoice</th>
                <th>Fulfilment status</th>
                <th>Brand status</th>
                <th>Master status</th>
                <th>Where</th>
              </tr>
            </thead>
            {q.isLoading ? <SkeletonRows cols={10} /> : (
              <tbody className={`table-body ${q.isFetching ? "opacity-70" : ""}`}>
                {rows.map((o) => {
                  const invPill = invoicePaymentPill(o);
                  return (
                    <tr key={o.id} onClick={() => navigate(`/orders/${o.id}`)} className="cursor-pointer hover:bg-sunken/50">
                      <td><Link to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold hover:underline">{o.order_number}</Link>
                      {o.skus && <div className="truncate text-[12px] text-faint">{o.skus}</div>}</td>
                      <td className="max-w-[160px] truncate">{o.brand_name}</td>
                      <td className="whitespace-nowrap text-muted">{fmtShort(o.order_date)}</td>
                      <td><div className="max-w-[200px] truncate">{o.customer_name ?? "—"}</div><div className="text-[12.5px] text-faint">{o.city}</div></td>
                      <td className="whitespace-nowrap text-right">{fmtMoney(o.cod_amount_expected, o.cod_currency)}</td>
                      <td>
                        {invPill ? (
                          <Pill {...invPill} />
                        ) : (
                          <span className="text-[12px] text-faint">—</span>
                        )}
                      </td>
                      <td><Pill {...fulfilmentStatus(o)} /></td>
                      <td><Pill {...brandStatus(o)} /></td>
                      <td>
                        <div className="flex items-center gap-2">
                          <Pill {...masterStatus(o)} />
                          <span className="text-[12.5px] text-muted">{since(o.status_changed_at || o.order_date)}</span>
                        </div>
                      </td>
                      <td className="max-w-[180px] truncate text-muted">{where(o)}</td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} title="Orders didn't load" />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <EmptyState icon={<Inbox className="h-6 w-6" />} title={filters ? "No orders match these filters" : "No orders here"} />
        )}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[13px] text-muted">
            <span>{page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => update({ page: String(page - 1) })} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
              <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => update({ page: String(page + 1) })} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
