import { useCallback, useState } from "react";
import { ChevronDown } from "lucide-react";
import { NOTE_REQUIRED, STATUS, TERMINAL } from "@/lib/status";
import type { OrderStatus, StatusTransition } from "@/lib/types";
import { useOps, type OpsRole } from "@/context/OpsContext";
import type { Perm } from "@/lib/permissions";
import { useBulkOrderAction, useTransitions, type BulkOpsAction } from "@/hooks/useData";
import { plural } from "@/lib/format";
import { Button } from "./ui/Button";
import { ActionDialog } from "./ActionDialog";
import { CourierBookDialog } from "./CourierBookDialog";
import { COURIER_LABEL, useCourierAccount, useCourierParcels } from "@/hooks/useCourier";
import { supabase } from "@/lib/supabase";
import { describeError } from "@/lib/errors";
import { toast } from "sonner";
import type { QueueOrder } from "@/hooks/useData";
import { DANGER, VERB, availableTransitions } from "./OrderActions";

/**
 * Moves that need per-order input (tracking number, cash collected, received counts) stay on the
 * order page; everything else the order page offers for this role is available in bulk.
 */
const NOT_BULK: OrderStatus[] = ["out_for_delivery"];

type Item = { key: string; label: string; action: BulkOpsAction; danger: boolean };

/** Bulk options for one order, mirroring the order page's status buttons plus Hold / Resume. */
export function bulkItemsFor(t: StatusTransition[], status: OrderStatus, role: OpsRole | null, can: (p: Perm) => boolean): Item[] {
  const items: Item[] = [];
  if (status === "hold" && can("orders.hold")) items.push({ key: "resume", label: "Resume", action: { kind: "resume" }, danger: false });
  for (const to of availableTransitions(t, status, role, can)) {
    if (NOT_BULK.includes(to)) continue;
    items.push({ key: to, label: VERB[to] ?? STATUS[to].label, action: { kind: "status", to }, danger: DANGER.includes(to) });
  }
  if (status !== "hold" && !TERMINAL.includes(status) && can("orders.hold")) items.push({ key: "hold", label: "Hold", action: { kind: "hold" }, danger: false });
  return items.sort((a, b) => Number(a.danger) - Number(b.danger));
}

/** Items every selected order allows, in a stable order. */
function commonItems(t: StatusTransition[], statuses: OrderStatus[], role: OpsRole | null, can: (p: Perm) => boolean): Item[] {
  if (statuses.length === 0) return [];
  const [first, ...rest] = [...new Set(statuses)].map((s) => bulkItemsFor(t, s, role, can));
  return first.filter((a) => rest.every((list) => list.some((b) => b.key === a.key)));
}

/** Hook for pages: which statuses can be ticked for bulk actions. */
export function useBulkSelectable() {
  const { role, can } = useOps();
  const t = useTransitions().data ?? [];
  return useCallback((status: OrderStatus) => bulkItemsFor(t, status, role, can).length > 0, [t, role, can]);
}

export function BulkOrderActions({ orders, onDone }: { orders: { id: string; status: OrderStatus }[]; onDone: () => void }) {
  const { role, can, isKbb } = useOps();
  const t = useTransitions().data ?? [];
  const bulk = useBulkOrderAction();
  // KBB: book the selection with the courier (all received / preparing, none booked yet).
  const courier = useCourierAccount();
  const parcels = useCourierParcels(isKbb ? orders.map((o) => o.id) : []);
  const [booking, setBooking] = useState<QueueOrder[] | null>(null);
  const [loadingBook, setLoadingBook] = useState(false);
  const courierOk = isKbb && can("deliveries.manage") && !!courier.data?.is_enabled && orders.length > 0
    && orders.every((o) => o.status === "received_by_partner" || o.status === "preparing_for_delivery")
    && !!parcels.data && orders.every((o) => !parcels.data!.has(o.id));
  const openBooking = async () => {
    setOpen(false);
    setLoadingBook(true);
    try {
      const { data, error } = await supabase.from("orders").select("*, brand:organizations(name), order_items(*)").in("id", orders.map((o) => o.id));
      if (error) throw error;
      setBooking((data ?? []) as QueueOrder[]);
    } catch (e) { toast.error(describeError(e)); } finally { setLoadingBook(false); }
  };
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Item | null>(null);
  const items = commonItems(t, orders.map((o) => o.status), role, can);
  const count = plural(orders.length, "order");

  const noteRequired = picked ? picked.action.kind === "hold" || (picked.action.kind === "status" && NOTE_REQUIRED.includes(picked.action.to)) : false;

  return (
    <>
      <div className="relative">
        <Button size="sm" variant="primary" loading={bulk.isPending || loadingBook} disabled={items.length === 0 && !courierOk}
          title={items.length === 0 && !courierOk ? "The selected orders are at different stages with no action in common" : undefined}
          onClick={() => setOpen((v) => !v)}>
          Bulk action <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </Button>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <div className="absolute right-0 z-30 mt-1 min-w-[210px] overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
              {courierOk && (
                <button onClick={() => void openBooking()} className="block w-full px-3 py-2 text-left text-[13.5px] font-medium text-ink hover:bg-sunken">
                  Book with {COURIER_LABEL}
                </button>
              )}
              {items.map((a) => (
                <button key={a.key} onClick={() => { setOpen(false); bulk.reset(); setPicked(a); }}
                  className={`block w-full px-3 py-2 text-left text-[13.5px] hover:bg-sunken ${a.danger ? "text-g-problem" : "text-ink"}`}>
                  {a.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {picked && (
        <ActionDialog open onClose={() => setPicked(null)} busy={bulk.isPending}
          title={`${picked.label}: ${count}`}
          description={picked.action.kind === "status" ? `Moves ${count} to ${STATUS[picked.action.to].label}.`
            : picked.action.kind === "hold" ? "Each order pauses where it is and resumes from the same step."
            : "Each order returns to the step it was on before the hold."}
          confirmLabel={picked.label} danger={picked.danger}
          noteLabel={noteRequired ? "Reason" : "Note"} noteRequired={noteRequired}
          notePlaceholder={picked.action.kind === "status" && picked.action.to === "needs_amendment" ? "What does the customer want changed?"
            : picked.action.kind === "status" && picked.action.to === "customer_unreachable" ? "e.g. No answer, try after 6pm" : undefined}
          onConfirm={(note) => bulk.mutate({ ids: orders.map((o) => o.id), action: picked.action, note },
            { onSuccess: () => { setPicked(null); onDone(); } })} />
      )}
      {booking && <CourierBookDialog orders={booking} onClose={() => { setBooking(null); onDone(); }} />}
    </>
  );
}
