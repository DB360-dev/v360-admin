import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { TextArea, TextField } from "./ui/Field";
import { describeError } from "@/lib/errors";
import { fmtMoney } from "@/lib/format";
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
  const pkItems = items.filter((i) => (i.fulfilment_origin ?? "pakistan") !== "bangladesh");
  const bdCount = items.length - pkItems.length;
  const [qty, setQty] = useState<Record<string, string>>({});
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      m.reset();
      setQty(Object.fromEntries(pkItems.map((i) => [i.id, String(i.quantity)])));
      setWeights(Object.fromEntries(pkItems.map((i) => [i.id, ""])));
      setNote("");
      setErr(null);
    }
  }, [open]);

  const parsed = pkItems.map((i) => ({ i, n: Math.max(0, Math.min(i.quantity, Math.floor(Number(qty[i.id] ?? 0) || 0))) }));
  const missing = parsed.filter(({ i, n }) => n < i.quantity);
  const weightRows = pkItems.map((i) => ({ i, raw: (weights[i.id] ?? "").trim(), w: Number(weights[i.id]) }));
  const weightMissing = weightRows.some((r) => r.raw === "" || !Number.isFinite(r.w) || r.w <= 0);
  const orderWeight = weightMissing ? null : weightRows.reduce((s, r) => s + r.w * r.i.quantity, 0);
  const submit = () => {
    if (weightMissing) { setErr("Enter the weight (kg) of every item"); return; }
    setErr(null);
    const payload = missing.length === 0 ? null : parsed.map(({ i, n }) => ({ item_id: i.id, received_quantity: n }));
    m.mutate({ id: order.id, weight: orderWeight!, items: payload, note }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={m.isPending} error={m.error ? describeError(m.error) : null}
      title={`Receive ${order.order_number}`} description="Count what physically arrived and record the weight of every item. The order only becomes ready for shipment when every item sent from Pakistan is here."
      footer={<>
        <Button onClick={onClose} disabled={m.isPending}>Cancel</Button>
        <Button type="submit" variant={missing.length ? "danger" : "primary"} loading={m.isPending}>
          {missing.length ? "Record mismatch" : "All received"}
        </Button>
      </>}>
      {bdCount > 0 && (
        <p className="mb-3 rounded border border-line bg-sunken/40 px-3 py-2 text-[12.5px] text-muted">
          {bdCount} SKU{bdCount > 1 ? "s" : ""} fulfilled locally in Bangladesh {bdCount > 1 ? "are" : "is"} excluded — {bdCount > 1 ? "they never reach" : "it never reaches"} the hub and aren't counted here.
        </p>
      )}
      <table className="w-full text-[13.5px]">
        <thead className="table-head"><tr><th>Item</th><th className="text-right">Ordered</th><th className="w-28 text-right">Received</th><th className="w-28 text-right">Weight kg</th></tr></thead>
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
              <td className="text-right">
                <input type="text" inputMode="decimal" placeholder="kg" aria-label={`Item weight for ${i.product_name}`}
                  className={`input h-8 w-20 text-right ${err && !(weights[i.id] ?? "").trim() ? "border-g-problem" : ""}`}
                  value={weights[i.id] ?? ""} onChange={(e) => { setWeights((s) => ({ ...s, [i.id]: e.target.value })); setErr(null); }} />
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
      {orderWeight !== null ? (
        <p className="mt-4 text-[13px] text-muted">
          Order weight ≈ {orderWeight} kg — each item's weight × its quantity, carried with the order into the shipment.
        </p>
      ) : err ? (
        <p role="alert" className="mt-4 text-[13px] text-danger">{err}</p>
      ) : null}
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

// ---------- Return decision (V360) — per item ----------------------------------------
const DISP_OPTIONS: { value: ReturnDispositionValue; label: string }[] = [
  { value: "restock_in_bd", label: "Restock in BD" },
  { value: "return_to_pk",  label: "Return to PK" },
  { value: "written_off",   label: "Write off" },
];

export function ReturnDialog({ order, items, open, onClose }: Base & { order: Order; items?: OrderItem[] }) {
  const m = useReturnDisposition({ inlineErrors: true });
  const [dispositions, setDispositions] = useState<Record<string, ReturnDispositionValue>>({});
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      m.reset();
      setNote("");
      setDispositions(
        Object.fromEntries((items ?? []).map((i) => [
          i.id,
          (i.return_disposition && i.return_disposition !== "pending" ? i.return_disposition : "restock_in_bd") as ReturnDispositionValue,
        ]))
      );
    }
  }, [open]);

  const setItem = (id: string, v: ReturnDispositionValue) =>
    setDispositions((s) => ({ ...s, [id]: v }));

  const submit = () => {
    const payload = (items ?? []).map((i) => ({
      order_item_id: i.id,
      disposition: dispositions[i.id] ?? "restock_in_bd",
    }));
    m.mutate({ id: order.id, items: payload, note }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={m.isPending}
      error={m.error ? describeError(m.error) : null} width="md"
      title={`Returned goods: ${order.order_number}`}
      description="Choose what happens to each returned item."
      footer={<><Button onClick={onClose} disabled={m.isPending}>Cancel</Button><Button type="submit" variant="primary" loading={m.isPending}>Save decision</Button></>}>
      <div className="divide-y divide-line">
        {(items ?? []).map((item) => {
          const cur = dispositions[item.id] ?? "restock_in_bd";
          return (
            <div key={item.id} className="py-3 first:pt-0 last:pb-0">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-medium">
                  {item.product_name}
                  {item.variant && <span className="font-normal text-muted"> · {item.variant}</span>}
                </span>
                <span className="shrink-0 text-[13px] text-muted">{item.quantity}×</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {DISP_OPTIONS.map(({ value, label }) => (
                  <label key={value}
                    className={`flex cursor-pointer items-center gap-1.5 rounded border px-2.5 py-1 text-[12.5px] transition-colors ${
                      cur === value ? "border-primary bg-primary-soft text-primary font-medium" : "border-line text-muted hover:border-ink hover:text-ink"
                    }`}>
                    <input type="radio" name={`disp-${item.id}`} checked={cur === value}
                      onChange={() => setItem(item.id, value)} className="sr-only" />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4"><TextArea label="Note" optional value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></div>
    </Dialog>
  );
}
