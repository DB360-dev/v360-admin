import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { TextArea, TextField } from "./ui/Field";
import { describeError } from "@/lib/errors";
import { fmtMoney } from "@/lib/format";
import { RETURN_DISPOSITION } from "@/lib/status";
import type { Order, OrderItem, ReturnDispositionValue } from "@/lib/types";
import { useMarkDelivered, useReceiveOrder, useReturnDisposition, useSetTracking, useUpdateOrderDetails } from "@/hooks/useData";

interface Base { open: boolean; onClose: () => void }

// ---------- Delivered + cash collected ---------------------------------
export function DeliveredDialog({ order, open, onClose }: Base & { order: Order }) {
  const m = useMarkDelivered({ inlineErrors: true });
  const expected = order.cod_amount_expected ?? 0;
  const cur = order.cod_currency ?? "BDT";
  const [cash, setCash] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { m.reset(); setCash(String(expected)); setNote(""); setErr(null); } }, [open]);

  const n = Number(cash);
  const differs = cash.trim() !== "" && !Number.isNaN(n) && n !== expected;
  const submit = () => {
    if (cash.trim() === "" || Number.isNaN(n) || n < 0) { setErr("Enter the cash collected (0 if prepaid)"); return; }
    if (differs && note.trim().length < 3) { setErr("Explain why the amount is different"); return; }
    setErr(null);
    m.mutate({ id: order.id, cash: n, note }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={m.isPending} error={m.error ? describeError(m.error) : null} width="sm"
      title={`Delivered: ${order.order_number}`} description={`${order.customer_name ?? ""}. Expected cash: ${fmtMoney(expected, cur)}`}
      footer={<><Button onClick={onClose} disabled={m.isPending}>Cancel</Button><Button type="submit" variant="primary" loading={m.isPending}>Mark delivered</Button></>}>
      <div className="space-y-4">
        <TextField label={`Cash collected (${cur})`} type="number" inputMode="decimal" min={0} step="any" value={cash}
          onChange={(e) => setCash(e.target.value)} error={err && !differs ? err : null} autoFocus />
        {differs && (
          <p className="flex gap-2 rounded bg-g-brand-bg px-3 py-2 text-[13px] text-g-brand">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {n < expected ? `${fmtMoney(expected - n, cur)} less than expected.` : `${fmtMoney(n - expected, cur)} more than expected.`} This will be flagged for settlement.
          </p>
        )}
        <TextArea label={differs ? "Why is it different?" : "Note"} optional={!differs} value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          error={err && differs ? err : null} />
      </div>
    </Dialog>
  );
}

// ---------- Last-mile tracking ------------------------------------------
export function TrackingDialog({ order, open, onClose }: Base & { order: Order }) {
  const m = useSetTracking({ inlineErrors: true });
  const [courier, setCourier] = useState("");
  const [tracking, setTracking] = useState("");
  const [errs, setErrs] = useState<{ c?: string; t?: string }>({});
  useEffect(() => { if (open) { m.reset(); setCourier(order.delivery_courier ?? ""); setTracking(order.delivery_tracking_number ?? ""); setErrs({}); } }, [open]);
  const submit = () => {
    const e: typeof errs = {};
    if (!courier.trim()) e.c = "Enter the courier";
    if (!tracking.trim()) e.t = "Enter the tracking number";
    setErrs(e);
    if (!Object.keys(e).length) m.mutate({ id: order.id, courier, tracking }, { onSuccess: onClose });
  };
  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={m.isPending} error={m.error ? describeError(m.error) : null} width="sm"
      title={`Delivery tracking: ${order.order_number}`}
      footer={<><Button onClick={onClose} disabled={m.isPending}>Cancel</Button><Button type="submit" variant="primary" loading={m.isPending}>Save</Button></>}>
      <div className="space-y-4">
        <div>
          <TextField label="Courier" list="bd-couriers" value={courier} onChange={(e) => setCourier(e.target.value)} error={errs.c} autoFocus />
          <datalist id="bd-couriers">{["Steadfast", "Pathao", "RedX", "Paperfly", "eCourier", "Sundarban", "KBB rider"].map((c) => <option key={c} value={c} />)}</datalist>
        </div>
        <TextField label="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} error={errs.t} />
      </div>
    </Dialog>
  );
}

// ---------- Hub receiving ------------------------------------------------
export function ReceiveDialog({ order, items, open, onClose }: Base & { order: Order; items: OrderItem[] }) {
  const m = useReceiveOrder({ inlineErrors: true });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) { m.reset(); setQty(Object.fromEntries(items.map((i) => [i.id, String(i.quantity)]))); setNote(""); }
  }, [open]);

  const parsed = items.map((i) => ({ i, n: Math.max(0, Math.min(i.quantity, Math.floor(Number(qty[i.id] ?? 0) || 0))) }));
  const missing = parsed.filter(({ i, n }) => n < i.quantity);
  const submit = () => {
    const payload = missing.length === 0 ? null : parsed.map(({ i, n }) => ({ item_id: i.id, received_quantity: n }));
    m.mutate({ id: order.id, items: payload, note }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={m.isPending} error={m.error ? describeError(m.error) : null}
      title={`Receive ${order.order_number}`} description="Count what physically arrived. The order only becomes ready for shipment when every item is here."
      footer={<>
        <Button onClick={onClose} disabled={m.isPending}>Cancel</Button>
        <Button type="submit" variant={missing.length ? "danger" : "primary"} loading={m.isPending}>
          {missing.length ? "Record mismatch" : "All received"}
        </Button>
      </>}>
      <table className="w-full text-[13.5px]">
        <thead className="table-head"><tr><th>Item</th><th className="text-right">Ordered</th><th className="w-28 text-right">Received</th></tr></thead>
        <tbody className="table-body">
          {parsed.map(({ i, n }) => (
            <tr key={i.id}>
              <td><div className="font-medium">{i.product_name}</div><div className="text-[12.5px] text-muted">{[i.variant, i.sku].filter(Boolean).join(", ")}</div></td>
              <td className="text-right">{i.quantity}</td>
              <td className="text-right">
                <input type="number" min={0} max={i.quantity} inputMode="numeric" aria-label={`Received quantity for ${i.product_name}`}
                  className={`input h-8 w-20 text-right ${n < i.quantity ? "border-g-problem text-g-problem" : ""}`}
                  value={qty[i.id] ?? ""} onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value }))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {missing.length > 0 && (
        <p className="mt-3 flex gap-2 rounded bg-g-problem-bg px-3 py-2 text-[13px] text-g-problem">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {missing.length} item line{missing.length > 1 ? "s" : ""} short. The order will be marked as a hub issue and the brand will see what's missing.
        </p>
      )}
      <div className="mt-4"><TextArea label="Receiving note" optional value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></div>
    </Dialog>
  );
}

// ---------- Edit customer (V360) ------------------------------------------
const FIELDS = [["customer_name", "Customer name"], ["customer_phone", "Phone"], ["address1", "Address"], ["address2", "Address line 2"],
  ["city", "City"], ["province", "Area / division"], ["zip", "Postcode"], ["customer_note", "Delivery note"]] as const;
type FK = (typeof FIELDS)[number][0];

export function EditCustomerDialog({ order, open, onClose }: Base & { order: Order }) {
  const m = useUpdateOrderDetails({ inlineErrors: true });
  const init = () => Object.fromEntries(FIELDS.map(([k]) => [k, (order[k] as string | null) ?? ""])) as Record<FK, string>;
  const [v, setV] = useState(init);
  useEffect(() => { if (open) { m.reset(); setV(init()); } }, [open]);
  const changed = FIELDS.map(([k]) => k).filter((k) => v[k].trim() !== ((order[k] as string | null) ?? "").trim());
  const submit = () => {
    if (!changed.length) return onClose();
    m.mutate({ id: order.id, changes: Object.fromEntries(changed.map((k) => [k, v[k].trim()])) }, { onSuccess: onClose });
  };
  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={m.isPending} error={m.error ? describeError(m.error) : null} width="lg"
      title={`Edit customer: ${order.order_number}`} description="Changing the phone or address of a confirmed order sends it back to KBB for reconfirmation."
      footer={<><Button onClick={onClose} disabled={m.isPending}>Cancel</Button><Button type="submit" variant="primary" loading={m.isPending} disabled={!changed.length}>Save changes</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(([k, label]) => (
          <div key={k} className={k === "address1" || k === "address2" || k === "customer_note" ? "sm:col-span-2" : ""}>
            <TextField label={label} value={v[k]} onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value }))} />
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// ---------- Return decision (V360) ----------------------------------------
export function ReturnDialog({ order, open, onClose }: Base & { order: Order }) {
  const m = useReturnDisposition({ inlineErrors: true });
  const [d, setD] = useState<ReturnDispositionValue>("restock_in_bd");
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { m.reset(); setD((order.return_disposition as ReturnDispositionValue) || "restock_in_bd"); setNote(""); } }, [open]);
  return (
    <Dialog open={open} onClose={onClose} onSubmit={() => m.mutate({ id: order.id, disposition: d, note }, { onSuccess: onClose })}
      busy={m.isPending} error={m.error ? describeError(m.error) : null} width="sm" title={`Returned goods: ${order.order_number}`}
      footer={<><Button onClick={onClose} disabled={m.isPending}>Cancel</Button><Button type="submit" variant="primary" loading={m.isPending}>Save decision</Button></>}>
      <fieldset className="space-y-2">
        <legend className="field-label">What happens to the items?</legend>
        {(Object.keys(RETURN_DISPOSITION) as ReturnDispositionValue[]).filter((x) => x !== "pending").map((x) => (
          <label key={x} className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-[13.5px] ${d === x ? "border-primary bg-primary-soft" : "border-line"}`}>
            <input type="radio" name="disp" checked={d === x} onChange={() => setD(x)} className="accent-[rgb(var(--primary))]" />
            {RETURN_DISPOSITION[x]}
          </label>
        ))}
      </fieldset>
      <div className="mt-4"><TextArea label="Note" optional value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></div>
    </Dialog>
  );
}
