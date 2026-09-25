import { useMemo, useState } from "react";
import { Search, Truck } from "lucide-react";
import { useQueue } from "@/hooks/useData";
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
  const count = (k: OrderStatus | "all") => (q.data ?? []).filter((o) => k === "all" || o.status === k).length;
  const list = useMemo(() => (q.data ?? []).filter((o) =>
    (tab === "all" || o.status === tab) &&
    (!search.trim() || `${o.order_number} ${o.customer_name} ${o.customer_phone} ${o.city} ${o.delivery_tracking_number}`.toLowerCase().includes(search.trim().toLowerCase()))
  ).sort((a, b) => new Date(b.order_date).getTime() - new Date(a.order_date).getTime()), [q.data, tab, search]);

  return (
    <>
      <PageHeader title="Deliveries" description="Orders KBB has received in Bangladesh. Record each attempt, and the cash collected on delivery." />
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
      {q.isLoading ? <Spinner /> : q.isError ? <div className="panel"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : list.length === 0 ? (
        <div className="panel"><EmptyState icon={<Truck className="h-6 w-6" />} title="Nothing to deliver here">Orders appear once KBB confirms receipt of a shipment.</EmptyState></div>
      ) : (
        <ul className="space-y-3">{list.map((o) => <QueueCard key={o.id} o={o} showItems={false} showDateAndMaster />)}</ul>
      )}
    </>
  );
}
