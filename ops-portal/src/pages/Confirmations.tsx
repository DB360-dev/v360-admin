import { useMemo, useState } from "react";
import { PhoneCall, Search } from "lucide-react";
import { useQueue } from "@/hooks/useData";
import { CONFIRM_QUEUE } from "@/lib/status";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";
import { QueueCard } from "@/components/QueueCard";

export function Confirmations() {
  const q = useQueue(CONFIRM_QUEUE);
  const [filter, setFilter] = useState<"all" | "fresh" | "retry">("all");
  const [search, setSearch] = useState("");
  const list = useMemo(() => (q.data ?? []).filter((o) =>
    (filter === "all" || (filter === "retry" ? o.status === "customer_unreachable" : o.status !== "customer_unreachable")) &&
    (!search.trim() || `${o.order_number} ${o.customer_name} ${o.customer_phone} ${o.brand?.name}`.toLowerCase().includes(search.trim().toLowerCase()))
  ), [q.data, filter, search]);
  const retry = (q.data ?? []).filter((o) => o.status === "customer_unreachable").length;

  return (
    <>
      <PageHeader title="Confirmations" description="Call each customer to confirm the order before the brand prepares it. Oldest first." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Filter" className="flex rounded border border-line p-0.5 text-[13px]">
          {([["all", `All (${q.data?.length ?? 0})`], ["fresh", "Not called yet"], ["retry", `Call again (${retry})`]] as const).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={filter === k} onClick={() => setFilter(k)}
              className={`rounded-[4px] px-3 py-1 ${filter === k ? "bg-sunken font-medium" : "text-muted hover:text-ink"}`}>{label}</button>
          ))}
        </div>
        <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <span className="sr-only">Search</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <input className="input pl-9" placeholder="Order, customer, phone, brand" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>
      {q.isLoading ? <Spinner /> : q.isError ? <div className="panel"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : list.length === 0 ? (
        <div className="panel"><EmptyState icon={<PhoneCall className="h-6 w-6" />} title={q.data!.length ? "No orders match" : "No calls to make"}>
          {q.data!.length ? "Try a different filter." : "New Bangladesh orders from Shopify appear here automatically."}
        </EmptyState></div>
      ) : (
        <ul className="space-y-3">{list.map((o) => <QueueCard key={o.id} o={o} />)}</ul>
      )}
    </>
  );
}
