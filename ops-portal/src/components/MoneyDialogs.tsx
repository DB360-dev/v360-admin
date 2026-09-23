import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useBrandOptions, useCreateSettlement, useMarkSettlementPaid, useMoneySettings, useRecordKbbPayment, useSettlements, useShipments } from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import type { KbbShipmentAccount, Settlement } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TextField } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/States";

function monthRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: iso(start), end: iso(end) };
}

// ---------------------------------------------------------------- create

export function CreateSettlementDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: () => void;
}) {
  const brands = useBrandOptions();
  const create = useCreateSettlement({ inlineErrors: true });
  const defaults = useMemo(monthRange, []);
  const [mode, setMode] = useState<"monthly" | "manual">("monthly");
  const [brandId, setBrandId] = useState("");
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      create.reset();
      setErr(null);
      setMode("monthly");
      setBrandId("");
      const m = monthRange();
      setStart(m.start);
      setEnd(m.end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    if (!brandId) { setErr("Choose a brand"); return; }
    if (mode === "monthly" && (!start || !end)) { setErr("Choose the period dates"); return; }
    setErr(null);
    create.mutate(
      mode === "monthly"
        ? { brandId, periodStart: start, periodEnd: end }
        : { brandId },
      { onSuccess: () => { onCreated(); onClose(); } },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={create.isPending}
      error={create.error ? describeError(create.error) : err}
      title="Create statement" width="sm"
      description="Settles every delivered order for this brand that isn't on a statement yet."
      footer={<>
        <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>Create statement</Button>
      </>}>
      <div className="space-y-4">
        <label className="block">
          <span className="field-label">Brand</span>
          <select className="input mt-1" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">Choose a brand…</option>
            {(brands.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <fieldset>
          <legend className="field-label">What to include</legend>
          <div className="mt-1 space-y-1.5 text-[13.5px]">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" checked={mode === "monthly"} onChange={() => setMode("monthly")} />
              Monthly statement for a date range
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" checked={mode === "manual"} onChange={() => setMode("manual")} />
              Pay now — all outstanding delivered orders
            </label>
          </div>
        </fieldset>
        {mode === "monthly" && (
          <div className="grid grid-cols-2 gap-3">
            <TextField label="From" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <TextField label="To" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- view / print

export function StatementDialog({ settlementId, open, onClose }: {
  settlementId: number | null; open: boolean; onClose: () => void;
}) {
  const q = useSettlements();
  const paid = useMarkSettlementPaid({ inlineErrors: true });
  const settings = useMoneySettings();
  const s = open ? (q.data ?? []).find((x) => x.id === settlementId) ?? null : null;

  if (!s) {
    return open ? (
      <Dialog open onClose={onClose} title="Statement" width="lg"><Spinner label="Loading statement" /></Dialog>
    ) : null;
  }

  const lines = [...(s.settlement_lines ?? [])].sort((a, b) => a.order_number.localeCompare(b.order_number));
  const company = settings.data?.invoice_company_name || "Operations partner";

  return (
    <Dialog open={open} onClose={onClose} width="lg"
      title={`${s.brand?.name ?? "Brand"} — statement`}
      description={s.kind === "monthly" && s.period_start && s.period_end
        ? `Period ${fmtDate(s.period_start)} to ${fmtDate(s.period_end)}`
        : "All outstanding delivered orders"}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        {s.status === "issued" && (
          <Button variant="primary" loading={paid.isPending}
            onClick={() => paid.mutate(s.id)}>Mark as paid</Button>
        )}
        <Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
      </>}>
      {paid.error && <p role="alert" className="mb-3 text-[13px] text-danger">{describeError(paid.error)}</p>}
      <div className="rounded border border-line bg-sunken/40 p-4 text-[13.5px] print:border-0 print:bg-white">
        <div className="mb-3 flex items-start justify-between gap-4 print:flex">
          <div>
            <div className="text-[15px] font-semibold">{company}</div>
            <div className="text-muted">Statement for {s.brand?.name}</div>
          </div>
          <div className="text-right text-[12.5px] text-muted">
            <div>#{s.id}</div>
            <div>{s.status === "paid" ? `Paid ${fmtDateTime(s.paid_at)}` : "Issued"}</div>
            <div>Created {fmtDate(s.created_at)}</div>
          </div>
        </div>
        <table className="w-full text-[13px]">
          <thead className="table-head"><tr>
            <th>Order</th><th>Delivered</th>
            <th className="text-right">Order total</th>
            <th className="text-right">Commission ({Number(s.commission_pct)}%)</th>
            <th className="text-right">Freight</th>
            <th className="text-right">Payable</th>
          </tr></thead>
          <tbody className="table-body">
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="font-medium">{l.order_number}</td>
                <td className="text-muted">{fmtDate(l.delivered_at)}</td>
                <td className="text-right">{fmtMoney(l.order_total, "PKR")}</td>
                <td className="text-right text-danger">−{fmtMoney(l.commission, "PKR")}</td>
                <td className="text-right text-danger">−{fmtMoney(l.freight_share_pkr, "PKR")}</td>
                <td className="text-right font-semibold">{fmtMoney(l.brand_payable, "PKR")}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line text-[13.5px]">
              <td colSpan={2} className="px-3 py-2 font-semibold">{s.order_count} orders</td>
              <td className="px-3 py-2 text-right font-semibold">{fmtMoney(s.total_order_total, "PKR")}</td>
              <td className="px-3 py-2 text-right font-semibold text-danger">−{fmtMoney(s.total_commission, "PKR")}</td>
              <td className="px-3 py-2 text-right font-semibold text-danger">−{fmtMoney(s.total_freight, "PKR")}</td>
              <td className="px-3 py-2 text-right font-semibold">{fmtMoney(s.total_payable, "PKR")}</td>
            </tr>
          </tfoot>
        </table>
        <p className="mt-3 text-[12px] text-muted">
          All amounts in PKR. Freight converted from BDT at the rate recorded when weight was entered.
        </p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- record payment

export function RecordPaymentDialog({ open, onClose, account }: {
  open: boolean; onClose: () => void; account: KbbShipmentAccount[];
}) {
  const record = useRecordKbbPayment({ inlineErrors: true });
  const shipments = useShipments("all");
  const [kind, setKind] = useState<"dispatch_advance" | "delivery_balance" | "credit">("dispatch_advance");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("PKR");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [shipmentId, setShipmentId] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      record.reset();
      setErr(null);
      setKind("dispatch_advance");
      setAmount("");
      setCurrency("PKR");
      setDate(new Date().toISOString().slice(0, 10));
      setShipmentId("");
      setOrderNumber("");
      setNote("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dispatched = (shipments.data ?? []).filter((s) => s.status !== "draft" && s.status !== "ready_for_dispatch");
  const row = account.find((a) => a.shipment_id === shipmentId);
  const remaining = row ? Number(row.net_balance) : null;

  const submit = () => {
    const n = Number(amount);
    if (!amount.trim() || Number.isNaN(n) || n <= 0) { setErr("Enter an amount greater than zero"); return; }
    if (kind === "dispatch_advance" && !shipmentId) { setErr("Choose the shipment"); return; }
    if (kind !== "dispatch_advance" && !orderNumber.trim()) { setErr("Enter the order number"); return; }
    if (!date) { setErr("Choose the payment date"); return; }
    setErr(null);

    if (kind === "dispatch_advance") {
      record.mutate({ kind, amount: n, currency, paymentDate: date, shipmentId, note }, { onSuccess: onClose });
      return;
    }
    // Resolve order number → id via order_overview (RLS-safe).
    void (async () => {
      const { data, error } = await supabaseOrderLookup(orderNumber.trim());
      if (error) { setErr(error); return; }
      if (!data) { setErr(`No order found with number ${orderNumber.trim()}`); return; }
      record.mutate({ kind, amount: n, currency, paymentDate: date, orderId: data, note }, { onSuccess: onClose });
    })();
  };

  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={record.isPending}
      error={record.error ? describeError(record.error) : err}
      title="Record KBB payment" width="md"
      description="Advances are paid per shipment when it leaves; delivery payments and refunds attach to one order."
      footer={<>
        <Button onClick={onClose} disabled={record.isPending}>Cancel</Button>
        <Button type="submit" variant="primary" loading={record.isPending}>Record payment</Button>
      </>}>
      <div className="space-y-4">
        <label className="block">
          <span className="field-label">Type</span>
          <select className="input mt-1" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="dispatch_advance">Dispatch advance (per shipment)</option>
            <option value="delivery_balance">Delivery payment (per order)</option>
            <option value="credit">Refund / credit to KBB (per order)</option>
          </select>
        </label>

        {kind === "dispatch_advance" ? (
          <label className="block">
            <span className="field-label">Shipment</span>
            <select className="input mt-1" value={shipmentId} onChange={(e) => setShipmentId(e.target.value)}>
              <option value="">Choose a shipment…</option>
              {dispatched.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
            </select>
            {row && (
              <p className="mt-1.5 text-[12.5px] text-muted">
                Outstanding on {row.shipment_code}: <strong>{fmtMoney(row.net_balance, "PKR")}</strong>
                {remaining !== null && remaining > 0 && amount && (
                  <> · after this payment: {fmtMoney(remaining - Number(amount || 0) * (currency === "PKR" ? 1 : 0), "PKR")}</>
                )}
              </p>
            )}
          </label>
        ) : (
          <TextField label="Order number" placeholder="e.g. #1001 or 1001" value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)} />
        )}

        <div className="grid grid-cols-3 gap-3">
          <TextField label="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <label className="block">
            <span className="field-label">Currency</span>
            <select className="input mt-1" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option>PKR</option>
              <option>BDT</option>
            </select>
          </label>
          <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <TextField label="Note" optional value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Bank transfer ref…" />
      </div>
    </Dialog>
  );
}

/** Look up an order id by order number; returns a readable error string. */
async function supabaseOrderLookup(number: string): Promise<{ data: string | null; error: string | null }> {
  const clean = number.replace(/^#/, "");
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("order_overview")
    .select("id, order_number")
    .or(`order_number.eq.#${clean},order_number.eq.${clean}`)
    .limit(1)
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: data?.id ?? null, error: null };
}
