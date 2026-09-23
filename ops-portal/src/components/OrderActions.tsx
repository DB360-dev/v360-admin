import { useMemo, useState, type ReactNode } from "react";
import { describeError } from "@/lib/errors";
import { DEDICATED, NOTE_REQUIRED, STATUS, TERMINAL } from "@/lib/status";
import type { OrderItem, OrderStatus, Order } from "@/lib/types";
import { useOps } from "@/context/OpsContext";
import {
  useAddNote, useChangeStatus, useHold, useOverride, useRemoveFromShipment, useResume, useTransitions,
} from "@/hooks/useData";
import { Button } from "./ui/Button";
import { ActionDialog } from "./ActionDialog";
import { DeliveredDialog, EditCustomerDialog, ReceiveDialog, ReturnDialog, TrackingDialog } from "./OrderDialogs";

/** Button wording for each target status. */
const VERB: Partial<Record<OrderStatus, string>> = {
  confirmation_pending: "Start confirmation",
  confirmed: "Confirmed",
  customer_unreachable: "Unreachable",
  needs_amendment: "Needs amendment",
  cancelled: "Cancel order",
  brand_preparing: "Mark brand preparing",
  ready_for_shipment: "Mark ready for shipment",
  preparing_for_delivery: "Preparing delivery",
  out_for_delivery: "Out for delivery",
  delivery_failed: "Delivery failed",
  returned: "Mark returned",
};
const PRIMARY: OrderStatus[] = ["confirmed", "out_for_delivery", "ready_for_shipment"];
const DANGER: OrderStatus[] = ["cancelled", "delivery_failed", "returned"];
const EDITABLE: OrderStatus[] = ["new", "confirmation_pending", "customer_unreachable", "needs_amendment", "confirmed", "brand_preparing"];

type Dlg =
  | { kind: "status"; to: OrderStatus }
  | { kind: "hold" | "resume" | "note" | "override" | "remove" | "delivered" | "tracking" | "receive" | "edit" | "return" };

export function useAvailableTransitions(status: OrderStatus): OrderStatus[] {
  const { isV360 } = useOps();
  const t = useTransitions().data ?? [];
  return useMemo(() => {
    const set = new Set<OrderStatus>();
    for (const r of t) {
      if (r.from_status !== status || DEDICATED.includes(r.to_status) || r.to_status === status) continue;
      if (isV360 || r.actor === "partner") set.add(r.to_status);
    }
    return [...set];
  }, [t, status, isV360]);
}

function hasVisible(children: ReactNode): boolean {
  return Array.isArray(children)
    ? children.some((c) => (Array.isArray(c) ? hasVisible(c) : c !== false && c != null))
    : children !== false && children != null;
}

export function OrderActions({ order, items, compact }: { order: Order; items?: OrderItem[]; compact?: boolean }) {
  const { isV360 } = useOps();
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const close = () => setDlg(null);
  const s = order.status;
  const moves = useAvailableTransitions(s);

  const change = useChangeStatus({ inlineErrors: true });
  const hold = useHold({ inlineErrors: true });
  const resume = useResume({ inlineErrors: true });
  const note = useAddNote({ inlineErrors: true });
  const override = useOverride({ inlineErrors: true });
  const remove = useRemoveFromShipment({ inlineErrors: true });
  const [overrideTo, setOverrideTo] = useState<OrderStatus | "">("");

  const open = (d: Dlg) => {
    change.reset(); hold.reset(); resume.reset(); note.reset(); override.reset(); remove.reset();
    if (d.kind === "override") setOverrideTo("");
    setDlg(d);
  };
  const size = "sm";

  const lastMile = ["received_by_partner", "preparing_for_delivery", "out_for_delivery", "delivery_failed"].includes(s);
  const sorted = [...moves].sort((a, b) => Number(DANGER.includes(a)) - Number(DANGER.includes(b)));

  // --- Group 1: status / confirmation buttons (move the order forward) ---
  const statusChildren = [
    s === "out_for_delivery" && <Button key="delivered" size={size} variant="primary" onClick={() => open({ kind: "delivered" })}>Mark delivered</Button>,
    isV360 && (s === "dispatched_to_hub" || s === "hub_issue") && items && (
      <Button key="receive" size={size} variant="primary" onClick={() => open({ kind: "receive" })}>Receive at hub</Button>
    ),
    s === "hold" && <Button key="resume" size={size} variant="primary" onClick={() => open({ kind: "resume" })}>Resume</Button>,
    ...sorted.map((to) => (
      <Button key={to} size={size} variant={PRIMARY.includes(to) ? "primary" : DANGER.includes(to) ? "danger-ghost" : "secondary"} onClick={() => open({ kind: "status", to })}>
        {VERB[to] ?? STATUS[to].label}
      </Button>
    )),
  ];

  // --- Group 2: action buttons (notes, hold, tracking, edits — never status moves) ---
  const actionChildren = [
    lastMile && <Button key="tracking" size={size} onClick={() => open({ kind: "tracking" })}>{order.delivery_tracking_number ? "Edit tracking" : "Add tracking"}</Button>,
    !compact && isV360 && s === "assigned_to_shipment" && <Button key="remove" size={size} onClick={() => open({ kind: "remove" })}>Remove from shipment</Button>,
    !compact && isV360 && s === "returned" && <Button key="return" size={size} onClick={() => open({ kind: "return" })}>Decide on return</Button>,
    !compact && isV360 && EDITABLE.includes(s) && <Button key="edit" size={size} onClick={() => open({ kind: "edit" })}>Edit customer</Button>,
    !compact && <Button key="note" size={size} variant="ghost" onClick={() => open({ kind: "note" })}>Add note</Button>,
    !compact && s !== "hold" && !TERMINAL.includes(s) && <Button key="hold" size={size} variant="ghost" onClick={() => open({ kind: "hold" })}>Hold</Button>,
    !compact && isV360 && <Button key="override" size={size} variant="ghost" onClick={() => open({ kind: "override" })}>Override</Button>,
  ];

  const hasStatus = hasVisible(statusChildren);
  const hasActions = hasVisible(actionChildren);

  return (
    <>
      {compact ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Status</span>
            {statusChildren}
          </div>
          {hasActions && (
            <>
              <span aria-hidden className="h-5 w-px bg-line" />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Actions</span>
                {actionChildren}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {hasStatus && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] font-semibold uppercase tracking-wide text-faint mr-1">Status</span>
              {statusChildren}
            </div>
          )}
          {hasActions && (
            <>
              {hasStatus && <span aria-hidden className="h-5 w-px bg-line" />}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] font-semibold uppercase tracking-wide text-faint mr-1">Actions</span>
                {actionChildren}
              </div>
            </>
          )}
        </div>
      )}

      {dlg?.kind === "status" && (
        <ActionDialog open onClose={close} busy={change.isPending} error={change.error ? describeError(change.error) : null}
          title={`${VERB[dlg.to] ?? STATUS[dlg.to].label}: ${order.order_number}`}
          description={`${STATUS[s].label} to ${STATUS[dlg.to].label}`}
          confirmLabel={VERB[dlg.to] ?? "Save"} danger={DANGER.includes(dlg.to)}
          noteLabel={NOTE_REQUIRED.includes(dlg.to) ? "Reason" : "Note"} noteRequired={NOTE_REQUIRED.includes(dlg.to)}
          notePlaceholder={dlg.to === "needs_amendment" ? "What does the customer want changed?" : dlg.to === "customer_unreachable" ? "e.g. No answer, try after 6pm" : undefined}
          onConfirm={(n) => change.mutate({ id: order.id, to: dlg.to, note: n }, { onSuccess: close })} />
      )}
      {dlg?.kind === "hold" && (
        <ActionDialog open onClose={close} busy={hold.isPending} error={hold.error ? describeError(hold.error) : null}
          title={`Hold ${order.order_number}`} description="The order pauses where it is and resumes from the same step."
          confirmLabel="Put on hold" noteLabel="Reason" noteRequired onConfirm={(n) => hold.mutate({ id: order.id, reason: n }, { onSuccess: close })} />
      )}
      {dlg?.kind === "resume" && (
        <ActionDialog open onClose={close} busy={resume.isPending} error={resume.error ? describeError(resume.error) : null}
          title={`Resume ${order.order_number}`} description={order.previous_status ? `It returns to "${STATUS[order.previous_status].label}".` : undefined}
          confirmLabel="Resume" noteLabel="Note" onConfirm={(n) => resume.mutate({ id: order.id, note: n }, { onSuccess: close })} />
      )}
      {dlg?.kind === "note" && (
        <ActionDialog open onClose={close} busy={note.isPending} error={note.error ? describeError(note.error) : null}
          title={`Note on ${order.order_number}`} description="Visible in the order timeline."
          confirmLabel="Add note" noteLabel="Note" noteRequired onConfirm={(n) => note.mutate({ id: order.id, note: n }, { onSuccess: close })} />
      )}
      {dlg?.kind === "remove" && (
        <ActionDialog open onClose={close} busy={remove.isPending} error={remove.error ? describeError(remove.error) : null}
          title={`Remove ${order.order_number} from its shipment?`} description="It goes back to ready for shipment."
          confirmLabel="Remove" noteLabel="Reason" onConfirm={(n) => remove.mutate({ orderId: order.id, note: n }, { onSuccess: close })} />
      )}
      {dlg?.kind === "override" && (
        <ActionDialog open onClose={close} busy={override.isPending} error={override.error ? describeError(override.error) : null}
          title={`Override status: ${order.order_number}`} description="Skips the normal rules. Use only to fix mistakes; it's logged with your reason."
          confirmLabel="Override" danger noteLabel="Reason" noteRequired validate={() => (overrideTo ? null : "Choose the new status")}
          onConfirm={(n) => overrideTo && override.mutate({ id: order.id, to: overrideTo, reason: n }, { onSuccess: close })}>
          <label className="block">
            <span className="field-label">New status</span>
            <select className="input" value={overrideTo} onChange={(e) => setOverrideTo(e.target.value as OrderStatus)}>
              <option value="">Choose…</option>
              {(Object.keys(STATUS) as OrderStatus[]).filter((x) => x !== s).map((x) => <option key={x} value={x}>{STATUS[x].label}</option>)}
            </select>
          </label>
        </ActionDialog>
      )}
      <DeliveredDialog order={order} open={dlg?.kind === "delivered"} onClose={close} />
      <TrackingDialog order={order} open={dlg?.kind === "tracking"} onClose={close} />
      {items && <ReceiveDialog order={order} items={items} open={dlg?.kind === "receive"} onClose={close} />}
      <EditCustomerDialog order={order} open={dlg?.kind === "edit"} onClose={close} />
      <ReturnDialog order={order} open={dlg?.kind === "return"} onClose={close} />
    </>
  );
}
