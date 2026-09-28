import { useMemo, useState } from "react";
import { Search, Truck } from "lucide-react";
import { useQueue, type QueueOrder } from "@/hooks/useData";
import { useOps } from "@/context/OpsContext";
import { COURIER_LABEL, useCourierAccount, useCourierParcels } from "@/hooks/useCourier";
import { Button } from "@/components/ui/Button";
import { CourierBookDialog } from "@/components/CourierBookDialog";
import { Checkbox } from "@/components/ui/Checkbox";
import { DELIVERY_QUEUE, STATUS } from "@/lib/status";
import type { OrderStatus } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";
import { QueueCard } from "@/components/QueueCard";

const TABS: { key: OrderStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "received_by_partner", label: STATUS.received_by_partner.label },
  { key: "preparing_for_delivery", label: "Preparing" },
  { key: "out_for_delivery", label: STATUS.out_for_delivery.label },
  { key: "delivery_failed", label: "Failed, retry or return" },
];

export function Deliveries() {
  const q = useQueue(DELIVERY_QUEUE);
  const [tab, setTab] = useState<OrderStatus | "all">("all");
  const [search, setSearch] = useState("");
  const { isKbb, can } = useOps();
  const courier = useCourierAccount();
  const parcels = useCourierParcels((q.data ?? []).map((o) => o.id));
  const [booking, setBooking] = useState<QueueOrder[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const count = (k: OrderStatus | "all") => (q.data ?? []).filter((o) => k === "all" || o.status === k).length;
  const list = useMemo(() => (q.data ?? []).filter((o) =>
    (tab === "all" || o.status === tab) &&
    (!search.trim() || `${o.order_number} ${o.customer_name} ${o.customer_phone} ${o.city} ${o.delivery_tracking_number}`.toLowerCase().includes(search.trim().toLowerCase()))
  ).sort((a, b) => new Date(b.order_date).getTime() - new Date(a.order_date).getTime()), [q.data, tab, search]);

  // Received / preparing, not booked with the courier yet — among the orders shown.
  const bookable = list.filter((o) => (o.status === "received_by_partner" || o.status === "preparing_for_delivery") && !parcels.data?.has(o.id));
  const canBook = isKbb && can("deliveries.manage") && !!courier.data?.is_enabled;
  const bookableIds = new Set(bookable.map((o) => o.id));
  const picked = bookable.filter((o) => selected.has(o.id));
  const allPicked = bookable.length > 0 && picked.length === bookable.length;
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  return (
    <>
      <PageHeader title="Deliveries" description="Orders KBB has received in Bangladesh. Record each attempt, and the cash collected on delivery."
        actions={canBook && (
          <Button variant="primary" disabled={!picked.length} onClick={() => setBooking(picked)}
            title={picked.length ? undefined : "Tick the orders to book"}>
            {picked.length ? `Book ${picked.length} with ${COURIER_LABEL}` : `Select orders to book with ${COURIER_LABEL}`}
          </Button>
        )} />
      <div role="tablist" className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-line px-1">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] ${tab === t.key ? "border-primary font-medium" : "border-transparent text-muted hover:text-ink"}`}>
            {t.label}{count(t.key) > 0 && <span className={`rounded-full px-1.5 text-[12px] ${t.key === "delivery_failed" ? "bg-g-problem-bg font-semibold text-g-problem" : "bg-sunken text-muted"}`}>{count(t.key)}</span>}
          </button>
        ))}
      </div>
      <label className="relative mb-4 block sm:max-w-xs">
        <span className="sr-only">Search</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
        <input className="input pl-9" placeholder="Order, customer, phone, area, tracking" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {canBook && bookable.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-[13.5px]">
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox checked={allPicked} indeterminate={picked.length > 0 && !allPicked}
              onChange={() => setSelected(allPicked ? new Set() : new Set(bookable.map((o) => o.id)))} />
            Select all {bookable.length} not booked yet
          </label>
          {picked.length > 0 && <button type="button" className="text-muted hover:text-ink" onClick={() => setSelected(new Set())}>Clear ({picked.length})</button>}
        </div>
      )}
      {q.isLoading ? <Spinner /> : q.isError ? <div className="panel"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : list.length === 0 ? (
        <div className="panel"><EmptyState icon={<Truck className="h-6 w-6" />} title="Nothing to deliver here">Orders appear once KBB confirms receipt of a shipment.</EmptyState></div>
      ) : (
        <ul className="space-y-3">{list.map((o) => (
          <QueueCard key={o.id} o={o} showItems={false} showDateAndMaster
            {...(canBook && bookableIds.has(o.id) ? { selected: selected.has(o.id), onSelect: (on: boolean) => toggle(o.id, on) } : {})} />
        ))}</ul>
      )}
      {booking && <CourierBookDialog orders={booking} onClose={() => { setBooking(null); setSelected(new Set()); }} />}
    </>
  );
}
