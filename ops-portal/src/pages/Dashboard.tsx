import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useAgeing, useDashboardCounts, useInvoicesList, useStatusCounts } from "@/hooks/useData";
import { CONFIRM_QUEUE, DELIVERY_QUEUE, GROUP_CLASSES, ORDER_VIEWS, STATUS, V360_STATUS_TRACK } from "@/lib/status";
import { since } from "@/lib/format";
import type { OrderStatus } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";

function Tile({ label, value, to, tone, sub }: { label: string; value: number | undefined; to: string; tone?: "attention" | "problem"; sub?: string }) {
  const color = tone === "problem" && value ? "text-g-problem" : tone === "attention" && value ? "text-g-brand" : "";
  return (
    <Link to={to} className="panel block px-4 py-3.5 hover:border-faint">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`mt-1 text-[26px] font-semibold leading-none tracking-tight ${value === undefined ? "text-faint" : color}`}>{value ?? "–"}</div>
      {sub && <div className="mt-1.5 text-[12px] text-faint">{sub}</div>}
    </Link>
  );
}

function Ageing({ statuses, title }: { statuses?: OrderStatus[]; title: string }) {
  const q = useAgeing(2, statuses);
  return (
    <section className="panel">
      <div className="border-b border-line px-4 py-3"><h2>{title}</h2><p className="text-[12.5px] text-muted">Stuck in the same step for more than 2 days</p></div>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data!.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-6 w-6 text-g-done" />} title="Nothing is stuck" />
      ) : (
        <ul className="divide-y divide-line">
          {q.data!.map((o) => (
            <li key={o.id}>
              <Link to={`/orders/${o.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken/60">
                <span className="w-20 font-semibold">{o.order_number}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{o.brand_name}</span>
                <StatusBadge status={o.status} discrepancy={o.returned_due_to_discrepancy} />
                <span className="w-10 text-right text-[12.5px] font-semibold text-g-problem">{since(o.status_changed_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Payments() {
  const q = useInvoicesList();
  const rows: { payment_status?: string | null }[] = q.data ?? [];
  const paid = rows.filter((r) => r.payment_status === "paid").length;
  const unpaid = rows.filter((r) => r.payment_status === "not_paid").length;
  const unpaidInvoices = rows.filter((r) => r.payment_status !== "paid").length;
  return (
    <section className="grid gap-3 sm:grid-cols-3">
      <Tile label="Paid" value={q.isLoading ? undefined : paid} to="/invoices" sub="Fully paid invoices" />
      <Tile label="Unpaid" value={q.isLoading ? undefined : unpaid} to="/invoices" sub="No payment received" />
      <Tile label="Unpaid invoices" value={q.isLoading ? undefined : unpaidInvoices} to="/invoices" sub="Any outstanding balance" />
    </section>
  );
}

export function Dashboard() {
  const { isV360, orgName } = useOps();
  const counts = useStatusCounts();
  const dash = useDashboardCounts(isV360);
  const c = counts.data;
  const sum = (ss: OrderStatus[] | null) => (c ? (ss ?? (Object.keys(c) as OrderStatus[])).reduce((n, s) => n + (c[s] ?? 0), 0) : undefined);
  const d = dash.data;

  if (counts.isError) return <ErrorState error={counts.error} onRetry={() => counts.refetch()} />;

  if (!isV360) {
    return (
      <>
        <PageHeader title="Today" description={`${orgName}: your confirmation calls, incoming shipments and deliveries.`} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile label="Orders to confirm" value={sum(CONFIRM_QUEUE)} to="/confirmations" tone="attention" sub="Call the customer" />
          <Tile label="Shipments on the way" value={d?.shipmentsMoving} to="/shipments" sub="Confirm receipt when they arrive" />
          <Tile label="Orders to deliver" value={sum(DELIVERY_QUEUE)} to="/deliveries" tone="attention" sub="Includes failed attempts" />
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Ageing title="Waiting too long" statuses={[...CONFIRM_QUEUE, ...DELIVERY_QUEUE]} />
        </div>
      </>
    );
  }

  const views = ORDER_VIEWS.filter((v) => v.key !== "all" && v.key !== "cancelled");
  const track = V360_STATUS_TRACK;
  return (
    <>
      <PageHeader title="Dashboard" description="Every brand's Bangladesh orders, live." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {views.map((v) => (
          <Tile key={v.key} label={v.label} value={sum(v.statuses)} to={`/orders?view=${v.key}`} tone={v.key === "problem" ? "problem" : undefined} />
        ))}
      </div>
      <h2 className="mb-3 mt-7">Master status</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {track.map((step) => {
          const n = c ? (c[step.status] ?? 0) : undefined;
          return (
            <Link key={step.status} to={`/orders?view=${step.status}`} className="flex items-center gap-2 rounded border border-line px-2.5 py-2 hover:border-faint">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[step.status] ? GROUP_CLASSES[STATUS[step.status].group].dot : "bg-faint"}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[13px]">{step.label}</span>
              <span className={`text-[14px] font-semibold ${n === undefined ? "text-faint" : n > 0 ? "text-ink" : "text-faint"}`}>{n ?? "–"}</span>
            </Link>
          );
        })}
      </div>
      <h2 className="mb-3 mt-7">Your queues</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Parcels to receive" value={d?.parcelsAwaiting} to="/receiving" tone="attention" sub="From brands, incl. mismatches" />
        <Tile label="Ready for shipment" value={c ? c.ready_for_shipment ?? 0 : undefined} to="/shipments" tone="attention"
          sub={d?.draftShipments ? `${d.draftShipments} shipment${d.draftShipments > 1 ? "s" : ""} being packed` : "Not in a shipment yet"} />
        <Tile label="Brand requests" value={d?.pendingBrands} to="/brands" tone="attention" sub="Waiting for approval" />
        <Tile label="Shopify sync errors" value={d?.failedWebhooks} to="/webhooks" tone="problem" sub="Orders that failed to import" />
      </div>
      <h2 className="mb-3 mt-7">Payments</h2>
      <Payments />
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Ageing title="Stuck orders" />
      </div>
    </>
  );
}
