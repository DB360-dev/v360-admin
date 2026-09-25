import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { TextArea, TextField } from "./ui/Field";
import { describeError } from "@/lib/errors";
import { fmtMoney } from "@/lib/format";
import type { Order, OrderItem, ReturnDispositionValue } from "@/lib/types";
import { bdQty, hubQty } from "@/lib/items";
import { useMarkDelivered, useMarkOutForDelivery, useReceiveOrder, useReturnDisposition, useSetTracking, useShopifyFulfill, useUpdateOrderDetails } from "@/hooks/useData";

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
/** Delivery tracking. With outForDelivery, also moves the order to "Out for delivery".
 *  Once the order is out for delivery, the tracking is pushed to Shopify as a fulfillment. */
export function TrackingDialog({ order, open, onClose, outForDelivery = false }: Base & { order: Order; outForDelivery?: boolean }) {
  const save = useSetTracking({ inlineErrors: true });
  const ofd = useMarkOutForDelivery({ inlineErrors: true });
  const fulfill = useShopifyFulfill();
  const m = outForDelivery ? ofd : save;
  const [courier, setCourier] = useState("");
  const [tracking, setTracking] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [errs, setErrs] = useState<{ c?: string; t?: string; u?: string }>({});
  useEffect(() => {
    if (open) {
      save.reset(); ofd.reset();
      setCourier(order.delivery_courier ?? ""); setTracking(order.delivery_tracking_number ?? "");
      setUrl(order.delivery_tracking_url ?? ""); setNote(""); setErrs({});
    }
  }, [open]);
  const done = () => {
    onClose();
    // Push to Shopify when the order is (now) out for delivery or later.
    if (outForDelivery || ["out_for_delivery", "delivered", "delivery_failed"].includes(order.status)) fulfill.mutate(order.id);
  };
  const submit = () => {
    const e: typeof errs = {};
    if (!courier.trim()) e.c = "Enter the courier";
    if (!tracking.trim()) e.t = "Enter the tracking number";
    if (url.trim() && !/^https?:\/\/\S+$/i.test(url.trim())) e.u = "Enter a full link starting with https://";
    setErrs(e);
    if (Object.keys(e).length) return;
    if (outForDelivery) ofd.mutate({ id: order.id, courier, tracking, url, note }, { onSuccess: done });
    else save.mutate({ id: order.id, courier, tracking, url }, { onSuccess: done });
  };
  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={m.isPending} error={m.error ? describeError(m.error) : null} width="sm"
      title={outForDelivery ? `Out for delivery: ${order.order_number}` : `Delivery tracking: ${order.order_number}`}
      description={outForDelivery ? "Add the courier's tracking. The customer's Shopify order is marked fulfilled with it." : undefined}
      footer={<><Button onClick={onClose} disabled={m.isPending}>Cancel</Button>
        <Button type="submit" variant="primary" loading={m.isPending}>{outForDelivery ? "Mark out for delivery" : "Save"}</Button></>}>
      <div className="space-y-4">
        <div>
          <TextField label="Courier" list="bd-couriers" value={courier} onChange={(e) => setCourier(e.target.value)} error={errs.c} autoFocus />
          <datalist id="bd-couriers">{["Steadfast", "Pathao", "RedX", "Paperfly", "eCourier", "Sundarban", "KBB rider"].map((c) => <option key={c} value={c} />)}</datalist>
        </div>
        <TextField label="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} error={errs.t} />
        <TextField label="Tracking link" optional type="url" inputMode="url" placeholder="https://steadfast.com.bd/t/…"
          value={url} onChange={(e) => setUrl(e.target.value)} error={errs.u} />
        {outForDelivery && <TextArea label="Note" optional rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
      </div>
    </Dialog>
  );
}

// ---------- Hub receiving ------------------------------------------------
export function ReceiveDialog({ order, items, open, onClose }: Base & { order: Order; items: OrderItem[] }) {
  const m = useReceiveOrder({ inlineErrors: true });
  const pkItems = items.filter((i) => hubQty(i) > 0);
  const bdItems = items.filter((i) => bdQty(i) > 0);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      m.reset();
      setQty(Object.fromEntries(pkItems.map((i) => [i.id, String(hubQty(i))])));
      setWeights(Object.fromEntries(pkItems.map((i) => [i.id, ""])));
      setNote("");
      setErr(null);
    }
  }, [open]);

  // Counts are Pakistan units only; the server adds each line's BD-stock units on top.
  const parsed = pkItems.map((i) => ({ i, exp: hubQty(i), n: Math.max(0, Math.min(hubQty(i), Math.floor(Number(qty[i.id] ?? 0) || 0))) }));
  const missing = parsed.filter(({ exp, n }) => n < exp);
  const weightRows = pkItems.map((i) => ({ i, raw: (weights[i.id] ?? "").trim(), w: Number(weights[i.id]) }));
  const weightMissing = weightRows.some((r) => r.raw === "" || !Number.isFinite(r.w) || r.w <= 0);
  const orderWeight = weightMissing ? null : weightRows.reduce((s, r) => s + r.w * hubQty(r.i), 0);
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
      {bdItems.length > 0 && (
        <div className="mb-3 rounded border border-line bg-sunken/40 px-3 py-2 text-[12.5px] text-muted">
          <p>Already in the brand's Bangladesh stock — these never reach the hub and aren't counted here:</p>
          <ul className="mt-1 space-y-0.5">
            {bdItems.map((i) => (
              <li key={i.id}><span className="font-semibold text-ink">{bdQty(i)}×</span> {i.product_name}{i.variant ? `, ${i.variant}` : ""}</li>
            ))}
          </ul>
        </div>
      )}
      <table className="w-full text-[13.5px]">
        <thead className="table-head"><tr><th>Item</th><th className="text-right">From PK</th><th className="w-28 text-right">Received</th><th className="w-28 text-right">Weight kg</th></tr></thead>
        <tbody className="table-body">
          {parsed.map(({ i, exp, n }) => (
            <tr key={i.id}>
              <td><div className="font-medium">{i.product_name}</div><div className="text-[12.5px] text-muted">{[i.variant, i.sku].filter(Boolean).join(", ")}</div></td>
              <td className="text-right">{exp}{bdQty(i) > 0 && <div className="text-[11.5px] text-faint">of {i.quantity} ordered</div>}</td>
              <td className="text-right">
                <input type="number" min={0} max={exp} inputMode="numeric" aria-label={`Received quantity for ${i.product_name}`}
                  className={`input h-8 w-20 text-right ${n < exp ? "border-g-problem text-g-problem" : ""}`}
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
// Cancelled before the shipment left Pakistan: the goods can only go back to the brand.
const IN_PK_DISP_OPTIONS: { value: ReturnDispositionValue; label: string }[] = [
  { value: "return_to_brand", label: "Return to brand" },
  { value: "written_off",     label: "Write off" },
];

export function ReturnDialog({ order, items, open, onClose, inPakistan = false }: Base & { order: Order; items?: OrderItem[]; inPakistan?: boolean }) {
  const options = inPakistan ? IN_PK_DISP_OPTIONS : DISP_OPTIONS;
  const fallback = options[0].value;
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
          (options.some((o) => o.value === i.return_disposition) ? i.return_disposition : fallback) as ReturnDispositionValue,
        ]))
      );
    }
  }, [open]);

  const setItem = (id: string, v: ReturnDispositionValue) =>
    setDispositions((s) => ({ ...s, [id]: v }));

  const submit = () => {
    const payload = (items ?? []).map((i) => ({
      order_item_id: i.id,
      disposition: dispositions[i.id] ?? fallback,
    }));
    m.mutate({ id: order.id, items: payload, note }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={m.isPending}
      error={m.error ? describeError(m.error) : null} width="md"
      title={`${order.status === "cancelled" ? "Cancelled" : "Returned"} goods: ${order.order_number}`}
      description={inPakistan ? "Cancelled before it left Pakistan. Choose what happens to each item." : "Choose what happens to each returned item."}
      footer={<><Button onClick={onClose} disabled={m.isPending}>Cancel</Button><Button type="submit" variant="primary" loading={m.isPending}>Save decision</Button></>}>
      <div className="divide-y divide-line">
        {(items ?? []).map((item) => {
          const cur = dispositions[item.id] ?? fallback;
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
                {options.map(({ value, label }) => (
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
