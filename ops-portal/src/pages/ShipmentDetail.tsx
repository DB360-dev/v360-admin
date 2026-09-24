import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, ChevronRight, FileText, PackagePlus, Scale } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { supabase } from "@/lib/supabase";
import {
  useAddToShipment, useBdConfirmReceiving, useBdReceivedItems, useBdSaveOrderReceiving, useOrderItems, useOrderList,
  useRemoveFromShipment, useSetShipmentBrandWeight, useShipment, useShipmentBrandWeights, useShipmentCalculatedWeight,
  useShipmentEvents, useShipmentOrdersWithItems, useShipmentStatus, useUpdateShipment,
} from "@/hooks/useData";
import type { BdReceivedItem, OrderWithItemsForBd } from "@/hooks/useData";
import { SHIPMENT_STATUS, V360_SHIPMENT_FLOW, nextV360ShipmentStatus } from "@/lib/status";
import { describeError } from "@/lib/errors";
import { fmtDateTime, fmtMoney, plural } from "@/lib/format";
import type { OrderOverview, ShipmentOverview, ShipmentStatus } from "@/lib/types";
import { Pill, StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog } from "@/components/ui/Dialog";
import { TextArea, TextField } from "@/components/ui/Field";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";
import { ActionDialog } from "@/components/ActionDialog";
import { KbbInvoiceDialog } from "@/components/KbbInvoiceDialog";
import { Facts, Section } from "./OrderDetail";

const KBB_HIDDEN_STEPS = new Set<ShipmentStatus>(["draft", "ready_for_dispatch", "handed_to_carrier"]);

function Stepper({ status }: { status: ShipmentOverview["status"] }) {
  const { isKbb } = useOps();
  // Legacy in_transit/customs map to handed_to_carrier for progress calculation
  const displayStatus: ShipmentStatus =
    status === "in_transit" || status === "customs" ? "handed_to_carrier" : status;
  const cur = V360_SHIPMENT_FLOW.indexOf(displayStatus);
  return (
    <ol className="flex flex-wrap gap-x-1 gap-y-2 text-[12.5px]" aria-label="Shipment progress">
      {V360_SHIPMENT_FLOW.map((s, i) => {
        if (isKbb && KBB_HIDDEN_STEPS.has(s)) return null;
        return (
          <li key={s} aria-current={i === cur ? "step" : undefined}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
              i < cur ? "border-primary/30 bg-primary-soft text-primary"
              : i === cur ? "border-primary bg-primary font-medium text-primary-fg"
              : "border-line text-faint"
            }`}>
            {i < cur && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
            {SHIPMENT_STATUS[s].label}
          </li>
        );
      })}
    </ol>
  );
}

function DetailsForm({ s, editable }: { s: ShipmentOverview; editable: boolean }) {
  const m = useUpdateShipment();
  const calcWeight = useShipmentCalculatedWeight(s.id);
  const calculatedTotal = calcWeight.data ?? 0;

  const [v, setV] = useState({ shipping_partner: "", tracking_number: "", total_weight_kg: "", notes: "" });

  const reset = () => {
    const defaultWeight = s.total_weight_kg !== null && s.total_weight_kg !== undefined
      ? String(s.total_weight_kg)
      : calculatedTotal > 0
      ? String(calculatedTotal)
      : "";
    setV({
      shipping_partner: s.shipping_partner ?? "",
      tracking_number: s.tracking_number ?? "",
      total_weight_kg: defaultWeight,
      notes: s.notes ?? "",
    });
  };

  useEffect(reset, [s.id, s.shipping_partner, s.tracking_number, s.total_weight_kg, s.notes, calculatedTotal]);

  const dirty = v.shipping_partner !== (s.shipping_partner ?? "") || v.tracking_number !== (s.tracking_number ?? "")
    || v.total_weight_kg !== (s.total_weight_kg === null ? "" : String(s.total_weight_kg)) || v.notes !== (s.notes ?? "");
  const weightErr = v.total_weight_kg.trim() && (Number.isNaN(Number(v.total_weight_kg)) || Number(v.total_weight_kg) < 0) ? "Enter a weight in kg" : null;

  if (!editable) {
    const displayWeight = s.total_weight_kg ?? (calculatedTotal > 0 ? calculatedTotal : null);
    return <Facts rows={[["Carrier", s.shipping_partner], ["Tracking", s.tracking_number], ["Weight", displayWeight ? `${displayWeight} kg` : null],
      ["Route", `${s.origin} to ${s.destination}`], ["Notes", s.notes]]} />;
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!weightErr) m.mutate({ id: s.id, ...v }); }} className="grid gap-4 sm:grid-cols-2">
      <TextField label="Shipping partner" value={v.shipping_partner} onChange={(e) => setV({ ...v, shipping_partner: e.target.value })} />
      <TextField label="Tracking ID" value={v.tracking_number} onChange={(e) => setV({ ...v, tracking_number: e.target.value })} hint="One ID for the whole shipment" />
      <div>
        <TextField
          label="Total weight (kg)"
          inputMode="decimal"
          value={v.total_weight_kg}
          placeholder={calculatedTotal > 0 ? `${calculatedTotal} (calculated)` : undefined}
          onChange={(e) => setV({ ...v, total_weight_kg: e.target.value })}
          error={weightErr}
          optional
        />
        {calculatedTotal > 0 && (
          <div className="mt-1 flex items-center justify-between text-[12px] text-muted">
            <span className="flex items-center gap-1">
              <Scale className="h-3 w-3 text-primary" /> Product sum: <strong className="text-ink">{calculatedTotal} kg</strong>
            </span>
            {v.total_weight_kg !== String(calculatedTotal) && (
              <button
                type="button"
                onClick={() => setV({ ...v, total_weight_kg: String(calculatedTotal) })}
                className="font-medium text-primary hover:underline"
              >
                Use calculated
              </button>
            )}
          </div>
        )}
      </div>
      <div className="text-[13.5px]"><span className="field-label">Route</span><p className="pt-2 text-muted">{s.origin} to {s.destination}</p></div>
      <div className="sm:col-span-2"><TextArea label="Notes" optional rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={!dirty} loading={m.isPending}>Save details</Button>
        {dirty && <Button onClick={reset}>Discard</Button>}
      </div>
    </form>
  );
}

function FreightSection({ shipment, editable }: { shipment: ShipmentOverview; editable: boolean }) {
  const weights = useShipmentBrandWeights(editable ? shipment.id : null);
  const orders = useOrderList({ statuses: null, shipmentId: shipment.id, limit: 500 });
  const save = useSetShipmentBrandWeight({ inlineErrors: true });

  const brands = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of orders.data?.rows ?? []) map.set(o.brand_id, o.brand_name);
    for (const w of weights.data ?? []) if (!map.has(w.brand_id)) map.set(w.brand_id, w.brand_id.slice(0, 8));
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [orders.data, weights.data]);

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const w of weights.data ?? []) next[w.brand_id] = String(w.weight_kg);
    setEdits(next);
  }, [weights.data]);

  if (weights.isLoading || orders.isLoading) return <Spinner />;
  if (weights.isError) return <ErrorState error={weights.error} onRetry={() => weights.refetch()} />;

  if (!editable) {
    const rows = (weights.data ?? []).map((w) => {
      const name = brands.find((b) => b.id === w.brand_id)?.name ?? w.brand_id.slice(0, 8);
      return [name, `${w.weight_kg} kg · ${fmtMoney(w.weight_kg * w.freight_bdt_per_kg * w.fx_rate, "PKR")} (rate ${w.freight_bdt_per_kg} BDT/kg, FX ${w.fx_rate})`] as [string, React.ReactNode];
    });
    if (!rows.length) return <p className="text-[13.5px] text-muted">No freight weights entered yet.</p>;
    return <Facts rows={rows} />;
  }

  const saveBrand = (brandId: string) => {
    const raw = (edits[brandId] ?? "").trim();
    const existing = weights.data?.find((w) => w.brand_id === brandId);
    const next = raw === "" ? null : Number(raw);
    if (next !== null && (Number.isNaN(next) || next < 0)) {
      setSaveErr("Enter a weight of 0 kg or more");
      return;
    }
    if (next !== null && existing && next === Number(existing.weight_kg)) return;
    setSaveErr(null);
    setSavingId(brandId);
    save.mutate({ shipmentId: shipment.id, brandId, weightKg: next }, {
      onSuccess: () => setSavingId(null),
      onError: (e) => { setSaveErr(describeError(e)); setSavingId(null); },
    });
  };

  return (
    <div>
      <p className="mb-3 text-[13px] text-muted">
        Enter each brand's total weight for this shipment. Freight is weight × BDT rate × FX, split across that brand's orders.
      </p>
      <ul className="space-y-2">
        {brands.map((b) => {
          const raw = edits[b.id] ?? "";
          const invalid = raw.trim() !== "" && (Number.isNaN(Number(raw)) || Number(raw) < 0);
          return (
            <li key={b.id} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  label={brands.length > 6 ? b.name : ""}
                  value={raw}
                  inputMode="decimal"
                  placeholder={brands.length > 6 ? undefined : b.name}
                  optional
                  error={invalid ? "Enter kg (0 or more)" : null}
                  onChange={(e) => setEdits((s) => ({ ...s, [b.id]: e.target.value }))}
                />
                {brands.length <= 6 && <p className="field-label mt-1">{b.name}</p>}
              </div>
              <Button
                size="sm"
                disabled={savingId === b.id || invalid}
                loading={savingId === b.id}
                onClick={() => saveBrand(b.id)}
              >
                Save
              </Button>
            </li>
          );
        })}
      </ul>
      {saveErr && <p role="alert" className="mt-2 text-[13px] text-danger">{saveErr}</p>}
    </div>
  );
}

type ReadyOrder = {
  id: string; order_number: string; customer_name: string | null; city: string | null;
  cod_amount_expected: number | null; cod_currency: string | null;
  brand: { id: string; name: string } | null;
  order_items: { sku: string | null; product_name: string; quantity: number }[];
  order_freight_weights: { weight_kg: number }[];
};

const fmtKg = (w: number | undefined | null) => (w === null || w === undefined || Number.isNaN(w) ? "—" : `${Number(w.toFixed(2))} kg`);

function AddOrdersDialog({ shipment, open, onClose }: { shipment: ShipmentOverview; open: boolean; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["ops", "ready-orders", open],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("id, order_number, customer_name, city, cod_amount_expected, cod_currency, brand:organizations(id, name), order_items(sku, product_name, quantity), order_freight_weights(weight_kg)")
        .eq("status", "ready_for_shipment")
        .order("order_number");
      if (error) throw error;
      const normalizeBrand = (b: unknown): ReadyOrder["brand"] =>
        Array.isArray(b) ? (b[0] as ReadyOrder["brand"]) ?? null : (b as ReadyOrder["brand"]);
      return ((data ?? []) as unknown as ReadyOrder[]).map((r) => ({ ...r, brand: normalizeBrand(r.brand) }));
    },
  });
  const add = useAddToShipment({ inlineErrors: true });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [brand, setBrand] = useState("");
  useEffect(() => { if (open) { add.reset(); setSel(new Set()); setBrand(""); } }, [open]); // eslint-disable-line
  const rows = q.data ?? [];
  const brands = [...new Set(rows.map((r) => r.brand?.name ?? "Unknown brand"))].sort();
  const grouped = useMemo(() => {
    const m = new Map<string, ReadyOrder[]>();
    for (const r of rows) {
      const n = r.brand?.name ?? "Unknown brand";
      const g = m.get(n);
      if (g) g.push(r); else m.set(n, [r]);
    }
    return [...m.entries()].map(([name, orders]) => ({
      name,
      orders,
      weight: orders.reduce((s, o) => s + (o.order_freight_weights?.[0]?.weight_kg ?? 0), 0),
    }));
  }, [rows]);
  const groups = grouped.filter((g) => !brand || g.name === brand);
  const shown = groups.flatMap((g) => g.orders);
  const all = shown.length > 0 && shown.every((r) => sel.has(r.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selWeight = rows.filter((r) => sel.has(r.id)).reduce((s, r) => s + (r.order_freight_weights?.[0]?.weight_kg ?? 0), 0);
  const skuList = (o: ReadyOrder) => o.order_items.map((i) => `${i.quantity}× ${i.sku ?? i.product_name}`).join(", ");

  return (
    <Dialog open={open} onClose={onClose} width="lg" busy={add.isPending} error={add.error ? describeError(add.error) : null}
      title={`Add orders to ${shipment.code}`} description="Only complete orders (every item received at the hub) can be added."
      onSubmit={() => sel.size && add.mutate({ shipmentId: shipment.id, orderIds: [...sel] }, { onSuccess: onClose })}
      footer={<><Button onClick={onClose} disabled={add.isPending}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!sel.size} loading={add.isPending}>
          Add {sel.size ? plural(sel.size, "order") : "orders"}{sel.size > 0 ? ` · ${fmtKg(selWeight)}` : ""}
        </Button></>}>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
        <EmptyState title="No orders are ready">Orders appear here once every item has been received at the hub.</EmptyState>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13.5px]"><Checkbox checked={all} onChange={() => setSel((s) => {
              const n = new Set(s); shown.forEach((r) => (all ? n.delete(r.id) : n.add(r.id))); return n; })} /> Select all shown</label>
            <select className="input ml-auto h-8 w-auto" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Filter by brand">
              <option value="">All brands ({rows.length})</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="flex items-baseline gap-2 border-b border-line pb-1 text-[13px]">
                  <span className="font-semibold">{g.name}</span>
                  <span className="text-faint">{plural(g.orders.length, "order")}{g.weight > 0 ? ` · ${fmtKg(g.weight)} total` : ""}</span>
                </div>
                <ul className="divide-y divide-line">
                  {g.orders.map((r) => {
                    const w = r.order_freight_weights?.[0]?.weight_kg;
                    return (
                      <li key={r.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13.5px] hover:bg-sunken/50">
                          <Checkbox checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                          <span className="w-20 shrink-0 font-semibold">{r.order_number}</span>
                          <span className="hidden max-w-[200px] truncate text-muted md:block" title={skuList(r)}>{skuList(r)}</span>
                          <span className="ml-auto flex items-center gap-3">
                            <span className="hidden w-20 truncate text-muted sm:block">{r.customer_name}, {r.city}</span>
                            <span className="w-16 text-right">{fmtKg(w)}</span>
                            <span className="w-24 text-right">{fmtMoney(r.cod_amount_expected, r.cod_currency)}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}

function OrderNumberCell({ order }: { order: OrderOverview }) {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const items = useOrderItems(active ? order.id : null);

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setActive(true);
  };
  const hide = () => {
    timerRef.current = setTimeout(() => setActive(false), 120);
  };

  return (
    <div className="relative inline-block" onMouseEnter={show} onMouseLeave={hide}>
      <Link to={`/orders/${order.id}`} className="font-semibold hover:underline">{order.order_number}</Link>
      {active && (
        <div
          className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-lg border border-line bg-surface p-2.5 shadow-pop text-[12.5px]"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          {items.isLoading ? (
            <span className="text-faint">Loading…</span>
          ) : items.data?.length === 0 ? (
            <span className="text-faint">No items</span>
          ) : (
            <ul className="space-y-1">
              {items.data?.map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-5 shrink-0 text-right font-medium">{item.quantity}×</span>
                  <span className="text-ink">{item.sku ?? item.product_name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

type ItemEdit = { qty: string; note: string };

function BdReceivingSection({ shipment, canOverride }: { shipment: ShipmentOverview; canOverride?: boolean }) {
  const orders = useShipmentOrdersWithItems(shipment.id);
  const received = useBdReceivedItems(shipment.id);
  const saveOrder = useBdSaveOrderReceiving({ inlineErrors: true });
  const confirm = useBdConfirmReceiving({ inlineErrors: true });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, ItemEdit>>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current || !orders.data || !received.data) return;
    initialized.current = true;
    const next: Record<string, Record<string, ItemEdit>> = {};
    for (const o of orders.data) {
      next[o.id] = {};
      for (const item of o.order_items) {
        const saved = received.data.find((r: BdReceivedItem) => r.order_item_id === item.id);
        next[o.id][item.id] = {
          qty: String(saved ? saved.received_qty : item.quantity),
          note: saved?.note ?? "",
        };
      }
    }
    setEdits(next);
  }, [orders.data, received.data]);

  const isOrderChecked = (orderId: string) => {
    const o = orders.data?.find((x) => x.id === orderId);
    return !!o && o.order_items.every((item) => received.data?.some((r: BdReceivedItem) => r.order_item_id === item.id));
  };

  const checkedCount = orders.data?.filter((o) => isOrderChecked(o.id)).length ?? 0;
  const totalOrders = orders.data?.length ?? 0;
  const allChecked = totalOrders > 0 && checkedCount === totalOrders;
  const unclearedDiscrepancies = received.data?.filter((r: BdReceivedItem) => r.received_qty !== r.expected_qty && !r.note).length ?? 0;
  const canConfirm = allChecked && unclearedDiscrepancies === 0;

  const setItemEdit = (orderId: string, itemId: string, patch: Partial<ItemEdit>) =>
    setEdits((prev) => ({
      ...prev,
      [orderId]: { ...prev[orderId], [itemId]: { ...(prev[orderId]?.[itemId] ?? { qty: "", note: "" }), ...patch } },
    }));

  const handleSaveOrder = (o: OrderWithItemsForBd) => {
    const orderEdits = edits[o.id] ?? {};
    const items = o.order_items.map((item) => ({
      order_item_id: item.id,
      received_qty: Math.max(0, Number(orderEdits[item.id]?.qty ?? item.quantity) || 0),
      note: orderEdits[item.id]?.note ?? "",
    }));
    setSaveErr(null);
    setSavingId(o.id);
    saveOrder.mutate(
      { shipmentId: shipment.id, orderId: o.id, items },
      {
        onSuccess: () => { setSavingId(null); setExpanded(null); },
        onError: (e) => { setSavingId(null); setSaveErr(describeError(e)); },
      },
    );
  };

  return (
    <Section title="Receiving check">
      <div className="mb-3 flex items-center justify-between text-[13.5px]">
        <span className="text-muted">{checkedCount} of {totalOrders} orders checked</span>
        {allChecked && unclearedDiscrepancies === 0 && (
          <span className="text-[12.5px] font-medium text-primary">All items verified</span>
        )}
      </div>

      {orders.isLoading || received.isLoading ? <Spinner /> : (
        <ul className="-mx-4 divide-y divide-line">
          {(orders.data ?? []).map((o) => {
            const checked = isOrderChecked(o.id);
            const isExpanded = expanded === o.id;
            const orderEdits = edits[o.id] ?? {};
            const orderDiscrepancies = o.order_items.filter((item) => {
              const saved = received.data?.find((r: BdReceivedItem) => r.order_item_id === item.id);
              return saved && saved.received_qty !== saved.expected_qty;
            });

            return (
              <li key={o.id}>
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-[13.5px] text-left hover:bg-sunken/50"
                  onClick={() => setExpanded(isExpanded ? null : o.id)}
                  aria-expanded={isExpanded}
                >
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
                    : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
                  <span className="w-28 shrink-0 font-semibold">{o.order_number}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{o.customer_name ?? "—"}</span>
                  <span className="flex items-center gap-2 text-[12.5px]">
                    <span className="text-faint">{o.order_items.length} item{o.order_items.length !== 1 ? "s" : ""}</span>
                    {orderDiscrepancies.length > 0 && (
                      <span className="font-medium text-g-problem">{orderDiscrepancies.length} short</span>
                    )}
                    {checked && orderDiscrepancies.length === 0 && (
                      <Check className="h-3.5 w-3.5 text-primary" strokeWidth={3} />
                    )}
                  </span>
                </button>

                {isExpanded && (
                  <div className="border-t border-line bg-sunken/30 px-4 pb-4 pt-3">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[480px] text-[13px]">
                        <thead>
                          <tr className="border-b border-line text-left text-faint">
                            <th className="pb-2 font-medium">Item</th>
                            <th className="pb-2 text-center font-medium">Expected</th>
                            <th className="pb-2 text-center font-medium">Received</th>
                            <th className="pb-2 font-medium">Note</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {o.order_items.map((item) => {
                            const edit = orderEdits[item.id] ?? { qty: String(item.quantity), note: "" };
                            const parsed = parseInt(edit.qty, 10);
                            const mismatch = !Number.isNaN(parsed) && parsed !== item.quantity;
                            const needsNote = mismatch && !edit.note.trim();
                            return (
                              <tr key={item.id}>
                                <td className="py-2 pr-4">
                                  <span>{item.product_name}</span>
                                  {item.sku && <span className="ml-1 text-faint">· {item.sku}</span>}
                                </td>
                                <td className="py-2 text-center font-medium">{item.quantity}</td>
                                <td className="py-2 text-center">
                                  <input
                                    type="number"
                                    min={0}
                                    value={edit.qty}
                                    onChange={(e) => setItemEdit(o.id, item.id, { qty: e.target.value })}
                                    className={`input w-16 text-center text-[13px] ${mismatch ? "border-g-problem text-g-problem" : ""}`}
                                  />
                                </td>
                                <td className="py-2 pl-3">
                                  <input
                                    type="text"
                                    placeholder={needsNote ? "Note required ↑" : "Optional note"}
                                    value={edit.note}
                                    onChange={(e) => setItemEdit(o.id, item.id, { note: e.target.value })}
                                    className={`input text-[13px] ${needsNote ? "border-g-problem" : ""}`}
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {saveErr && savingId === o.id && (
                      <p role="alert" className="mt-2 text-[13px] text-danger">{saveErr}</p>
                    )}
                    <div className="mt-3 flex justify-end">
                      <Button
                        size="sm"
                        variant="primary"
                        loading={savingId === o.id}
                        disabled={!!savingId}
                        onClick={() => handleSaveOrder(o)}
                      >
                        Save check
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button
          variant="primary"
          disabled={!canConfirm || confirm.isPending}
          loading={confirm.isPending}
          onClick={() => {
            setConfirmErr(null);
            confirm.mutate(
              { shipmentId: shipment.id, override: false },
              { onError: (e) => setConfirmErr(describeError(e)) },
            );
          }}
        >
          Complete receiving
        </Button>
        {canOverride && allChecked && unclearedDiscrepancies > 0 && (
          <Button
            variant="ghost"
            disabled={confirm.isPending}
            loading={confirm.isPending}
            onClick={() => {
              setConfirmErr(null);
              confirm.mutate(
                { shipmentId: shipment.id, override: true },
                { onError: (e) => setConfirmErr(describeError(e)) },
              );
            }}
          >
            Override & complete
          </Button>
        )}
        {!allChecked && (
          <span className="text-[13px] text-muted">{totalOrders - checkedCount} order(s) not yet checked</span>
        )}
        {allChecked && unclearedDiscrepancies > 0 && (
          <span className="text-[13px] text-g-problem">{unclearedDiscrepancies} discrepancy(s) need notes</span>
        )}
        {confirmErr && <p role="alert" className="text-[13px] text-danger">{confirmErr}</p>}
      </div>
    </Section>
  );
}

export function ShipmentDetail() {
  const { id = "" } = useParams();
  const { isV360, isKbb } = useOps();
  const q = useShipment(id);
  const orders = useOrderList({ statuses: null, shipmentId: id, limit: 500 });
  const events = useShipmentEvents(id);
  const move = useShipmentStatus({ inlineErrors: true });
  const remove = useRemoveFromShipment({ inlineErrors: true });
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(false);
  const [removing, setRemoving] = useState<OrderOverview | null>(null);
  const [showKbbInvoice, setShowKbbInvoice] = useState(false);

  const s = q.data;
  const next = s ? nextV360ShipmentStatus(s.status) : null;
  const packing = !!s && (s.status === "draft" || s.status === "ready_for_dispatch");
  const kbbCanReceive = !!s && isKbb && ["handed_to_carrier", "in_transit", "customs"].includes(s.status);
  const target = isKbb ? "received_by_partner" : next;
  const blocker = useMemo(() => {
    if (!s || !target) return null;
    if (target !== "draft" && target !== "ready_for_dispatch" && s.order_count === 0) return "Add orders first";
    if (["handed_to_carrier", "arrived_bd", "received_by_partner"].includes(target) && (!s.tracking_number || !s.shipping_partner))
      return "Save the shipping partner and tracking ID first";
    return null;
  }, [s, target]);

  if (q.isLoading) return <Spinner label="Loading shipment" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!s) return <EmptyState title="Shipment not found" action={<Link to="/shipments" className="link">All shipments</Link>} />;

  return (
    <>
      <Link to="/shipments" className="mb-4 inline-flex items-center gap-1.5 text-[13.5px] text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" /> Shipments</Link>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3"><h1>{s.code}</h1><Pill {...SHIPMENT_STATUS[s.status]} /></div>
          <p className="mt-1 text-[14px] text-muted">{plural(s.order_count, "order")} from {plural(s.brand_count, "brand")}, {fmtMoney(s.cod_expected, "BDT")} to collect</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setShowKbbInvoice(true)}>
            <FileText className="h-4 w-4" /> KBB Invoice PDF
          </Button>
          {isV360 && packing && <Button onClick={() => setAdding(true)}><PackagePlus className="h-4 w-4" /> Add orders</Button>}
          {((isV360 && next && s.status !== "arrived_bd") || kbbCanReceive) && target && (
            <Button variant="primary" onClick={() => { move.reset(); setMoving(true); }}>
              {isKbb ? "Mark as received by kbb" : `Mark as ${SHIPMENT_STATUS[target].label.toLowerCase()}`}
            </Button>
          )}
        </div>
      </header>
      <div className="panel mb-6 p-4"><Stepper status={s.status} /></div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <Section title="Orders in this shipment">
            {orders.isLoading ? <Spinner /> : orders.isError ? <ErrorState error={orders.error} onRetry={() => orders.refetch()} /> : orders.data!.rows.length === 0 ? (
              <EmptyState title="Empty shipment" action={isV360 && packing ? <Button variant="primary" onClick={() => setAdding(true)}>Add orders</Button> : undefined}>
                Add orders that are ready for shipment.
              </EmptyState>
            ) : (
              <div className="-m-4 overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13.5px]">
                  <thead className="table-head"><tr><th>Order</th><th>Brand</th><th>Customer</th><th className="text-right">Items</th><th className="text-right">COD</th><th>Status</th>{isV360 && packing && <th />}</tr></thead>
                  <tbody className="table-body">
                    {orders.data!.rows.map((o) => (
                      <tr key={o.id}>
                        <td><OrderNumberCell order={o} /></td>
                        <td>{o.brand_name}</td>
                        <td><div className="max-w-[180px] truncate">{o.customer_name}</div><div className="text-[12.5px] text-faint">{o.city}</div></td>
                        <td className="text-right">{o.item_count}</td>
                        <td className="whitespace-nowrap text-right">{fmtMoney(o.cod_amount_expected, o.cod_currency)}</td>
                        <td><StatusBadge status={o.status} /></td>
                        {isV360 && packing && <td className="text-right"><Button size="sm" variant="ghost" onClick={() => { remove.reset(); setRemoving(o); }}>Remove</Button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          {s.status === "arrived_bd" && <BdReceivingSection shipment={s} canOverride={isV360} />}
        </div>
        <aside className="space-y-6">
          <Section title="Details"><DetailsForm s={s} editable={isV360 && s.status !== "received_by_partner"} /></Section>
          {isV360 && (
            <Section title="Freight weight">
              <FreightSection shipment={s} editable={isV360 && s.status !== "received_by_partner"} />
            </Section>
          )}
          <Section title="History">
            {events.isLoading ? <Spinner /> : (
              <ol className="space-y-3 text-[13.5px]">
                {(events.data ?? []).map((e) => (
                  <li key={e.id}>
                    <div className="font-medium">{e.to_status ? SHIPMENT_STATUS[e.to_status].label : e.action}</div>
                    {e.note && <div className="text-muted">{e.note}</div>}
                    <div className="text-[12.5px] text-faint">{fmtDateTime(e.created_at)}</div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </aside>
      </div>

      {isV360 && <AddOrdersDialog shipment={s} open={adding} onClose={() => setAdding(false)} />}
      {target && (
        <ActionDialog open={moving} onClose={() => setMoving(false)} busy={move.isPending} error={move.error ? describeError(move.error) : null}
          title={isKbb ? `Confirm KBB received ${s.code}` : `${s.code}: ${SHIPMENT_STATUS[target].label}`}
          description={isKbb ? `All ${plural(s.order_count, "order")} inside become "Received by KBB" and move to Deliveries.`
            : target === "handed_to_carrier" ? "The shipment leaves the hub. Its orders can no longer be changed." : "Every order in the shipment updates with it."}
          confirmLabel={isKbb ? "Confirm receipt" : "Update shipment"} noteLabel="Note"
          validate={() => blocker} onConfirm={(n) => move.mutate({ id: s.id, to: target, note: n }, { onSuccess: () => setMoving(false) })} />
      )}
      {removing && (
        <ActionDialog open onClose={() => setRemoving(null)} busy={remove.isPending} error={remove.error ? describeError(remove.error) : null}
          title={`Remove ${removing.order_number}?`} description="It goes back to ready for shipment." confirmLabel="Remove" noteLabel="Reason"
          onConfirm={(n) => remove.mutate({ orderId: removing.id, note: n }, { onSuccess: () => setRemoving(null) })} />
      )}
      <KbbInvoiceDialog open={showKbbInvoice} onClose={() => setShowKbbInvoice(false)} shipment={s} />
    </>
  );
}
