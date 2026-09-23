import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import { useBatchOrders, useInboundBatches, type OrderWithItems } from "@/hooks/useData";
import { INBOUND_STATUS } from "@/lib/status";
import { fmtDate, since } from "@/lib/format";
import type { InboundBatchAdmin } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill, StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";
import { ReceiveDialog } from "@/components/OrderDialogs";

function BatchOrders({ batch }: { batch: InboundBatchAdmin }) {
  const q = useBatchOrders(batch.id);
  const [receiving, setReceiving] = useState<OrderWithItems | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      <ul className="divide-y divide-line">
        {q.data!.map((o) => {
          const canReceive = o.status === "dispatched_to_hub" || o.status === "hub_issue";
          return (
            <li key={o.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="w-24"><Link to={`/orders/${o.id}`} className="font-semibold hover:underline">{o.order_number}</Link></div>
              <ul className="min-w-[220px] flex-1 space-y-0.5 text-[13px]">
                {o.order_items.map((i) => (
                  <li key={i.id}>
                    <span className="font-semibold">{i.quantity}×</span> {i.product_name}{i.variant ? `, ${i.variant}` : ""}
                    {o.status === "hub_issue" && i.received_quantity < i.quantity && <span className="ml-2 font-medium text-g-problem">{i.received_quantity} received</span>}
                  </li>
                ))}
              </ul>
              <StatusBadge status={o.status} />
              {canReceive && <Button size="sm" variant="primary" onClick={() => setReceiving(o)}>{o.status === "hub_issue" ? "Recount" : "Receive"}</Button>}
            </li>
          );
        })}
      </ul>
      {receiving && <ReceiveDialog order={receiving} items={receiving.order_items} open onClose={() => setReceiving(null)} />}
    </>
  );
}

export function Receiving() {
  const [scope, setScope] = useState<"open" | "all">("open");
  const q = useInboundBatches(scope);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Hub receiving" description="Parcels brands have sent to the Lahore hub. Count every item; complete orders become ready for shipment."
        actions={
          <div role="radiogroup" className="flex rounded border border-line p-0.5 text-[13px]">
            {([["open", "To receive"], ["all", "All parcels"]] as const).map(([k, l]) => (
              <button key={k} role="radio" aria-checked={scope === k} onClick={() => setScope(k)} className={`rounded-[4px] px-3 py-1 ${scope === k ? "bg-sunken font-medium" : "text-muted"}`}>{l}</button>
            ))}
          </div>} />
      {q.isLoading ? <Spinner /> : q.isError ? <div className="panel"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : q.data!.length === 0 ? (
        <div className="panel"><EmptyState icon={<Inbox className="h-6 w-6" />} title="No parcels waiting">When a brand dispatches orders to the hub, the parcel appears here.</EmptyState></div>
      ) : (
        <ul className="space-y-3">
          {q.data!.map((b) => {
            const isOpen = open === b.id;
            const st = INBOUND_STATUS[b.status];
            return (
              <li key={b.id} className="panel overflow-hidden">
                <button onClick={() => setOpen(isOpen ? null : b.id)} aria-expanded={isOpen}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-sunken/50">
                  {isOpen ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronRight className="h-4 w-4 text-muted" />}
                  <span className="font-semibold">{b.brand_name}</span>
                  <span className="text-[13.5px] text-muted">{b.courier}{b.tracking_number ? ` ${b.tracking_number}` : ""}</span>
                  <span className="text-[13px] text-faint">sent {fmtDate(b.dispatch_date)}, {since(b.created_at)} ago</span>
                  <span className="ml-auto text-[13px]">{b.received_count} of {b.order_count} received</span>
                  <Pill {...st} />
                </button>
                {b.notes && isOpen && <p className="border-t border-line bg-sunken/40 px-4 py-2 text-[13px] text-muted">Brand note: {b.notes}</p>}
                {isOpen && <div className="border-t border-line"><BatchOrders batch={b} /></div>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
