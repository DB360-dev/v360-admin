import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Boxes, Plus, Ship } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useCreateShipment, useCreateShipmentWithOrders, useOrderList, useShipments } from "@/hooks/useData";
import { SHIPMENT_STATUS } from "@/lib/status";
import { fmtDateTime, fmtMoney, plural } from "@/lib/format";
import { describeError } from "@/lib/errors";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { TextArea, TextField } from "@/components/ui/Field";
import { ActionDialog } from "@/components/ActionDialog";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

/** Order-driven shipment builder: pick ready orders, create the shipment in one go. */
function ShipmentBuilder({ onCreated }: { onCreated: (id: string) => void }) {
  const q = useOrderList({ statuses: ["ready_for_shipment"], limit: 500, oldestFirst: true });
  const create = useCreateShipmentWithOrders({ inlineErrors: true });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [brand, setBrand] = useState("");
  const [partner, setPartner] = useState("");
  const [notes, setNotes] = useState("");

  const rows = q.data?.rows ?? [];
  const brands = useMemo(() => [...new Set(rows.map((r) => r.brand_name))].sort(), [rows]);

  const groupedByBrand = useMemo(() => {
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      const b = r.brand_name || "Unassigned Brand";
      const existing = map.get(b);
      if (existing) {
        existing.push(r);
      } else {
        map.set(b, [r]);
      }
    }
    return [...map.entries()].map(([brandName, orders]) => ({
      brandName,
      orders,
    }));
  }, [rows]);

  const filteredGroups = useMemo(
    () => groupedByBrand.filter((g) => !brand || g.brandName === brand),
    [groupedByBrand, brand]
  );

  const shownOrders = useMemo(() => filteredGroups.flatMap((g) => g.orders), [filteredGroups]);
  const allSelected = shownOrders.length > 0 && shownOrders.every((r) => sel.has(r.id));
  const someSelected = shownOrders.some((r) => sel.has(r.id));

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleBrandAll = (brandOrders: typeof rows) => {
    const brandAllSelected = brandOrders.every((r) => sel.has(r.id));
    setSel((prev) => {
      const next = new Set(prev);
      brandOrders.forEach((r) => {
        if (brandAllSelected) next.delete(r.id);
        else next.add(r.id);
      });
      return next;
    });
  };

  const submit = () => {
    if (!sel.size) return;
    create.mutate(
      { orderIds: [...sel], partner, notes },
      {
        onSuccess: (id) => {
          setSel(new Set());
          setBrand("");
          onCreated(id);
        },
      }
    );
  };

  return (
    <section className="mb-6 space-y-4">
      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            Orders ready for shipment
            {rows.length > 0 && (
              <span className="rounded-full bg-sunken px-2 py-0.5 text-[12px] text-muted font-normal">
                {rows.length}
              </span>
            )}
          </h2>
          {rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-[13.5px]">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onChange={() =>
                    setSel((s) => {
                      const n = new Set(s);
                      shownOrders.forEach((r) => (allSelected ? n.delete(r.id) : n.add(r.id)));
                      return n;
                    })
                  }
                />
                Select all shown ({shownOrders.length})
              </label>
              {brands.length > 1 && (
                <select
                  className="input h-8 w-auto text-[13px]"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  aria-label="Filter by brand"
                >
                  <option value="">All brands ({brands.length})</option>
                  {brands.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {q.isLoading ? (
          <SkeletonRows cols={5} rows={3} />
        ) : q.isError ? (
          <div className="p-4">
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No orders are ready">
              Orders appear here once every item has been received at the hub.
            </EmptyState>
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No orders found for this brand">
              Try selecting all brands to see ready orders.
            </EmptyState>
          </div>
        ) : null}
      </div>

      {!q.isLoading && !q.isError && rows.length > 0 && filteredGroups.length > 0 && (
        <>
          {/* Brand Boxes */}
          <div className="space-y-4">
            {filteredGroups.map((g) => {
              const brandAll = g.orders.every((r) => sel.has(r.id));
              const brandSome = g.orders.some((r) => sel.has(r.id));
              const selCount = g.orders.filter((r) => sel.has(r.id)).length;

              return (
                <div key={g.brandName} className="panel overflow-hidden">
                  <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        checked={brandAll}
                        indeterminate={brandSome && !brandAll}
                        onChange={() => toggleBrandAll(g.orders)}
                        id={`brand-cb-${g.brandName}`}
                      />
                      <label
                        htmlFor={`brand-cb-${g.brandName}`}
                        className="flex cursor-pointer items-center gap-2 font-semibold text-[14.5px] text-ink"
                      >
                        {g.brandName}
                      </label>
                      <span className="rounded-full bg-sunken px-2 py-0.5 text-[12px] font-medium text-muted border border-line/50">
                        {plural(g.orders.length, "order")}
                      </span>
                    </div>
                    {selCount > 0 && (
                      <span className="rounded bg-primary-soft px-2 py-0.5 text-[12.5px] font-medium text-primary">
                        {selCount} selected
                      </span>
                    )}
                  </div>
                  <ul className="divide-y divide-line">
                    {g.orders.map((r) => (
                      <li key={r.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-[13.5px] hover:bg-sunken/50 transition-colors">
                          <Checkbox checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                          <span className="min-w-[140px] font-semibold text-ink">{r.order_number}</span>
                          <span className="flex-1 truncate text-muted">
                            {r.customer_name ? `${r.customer_name}, ${r.city}` : r.city}
                          </span>
                          <span className="w-24 text-right text-muted">{r.item_count} items</span>
                          <span className="w-32 text-right font-medium">
                            {fmtMoney(r.cod_amount_expected, r.cod_currency)}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          {/* Action Footer */}
          <div className="panel flex flex-wrap items-end gap-3 bg-sunken/30 px-4 py-3">
            <div className="w-56">
              <TextField
                label="Shipping partner"
                optional
                list="carriers"
                value={partner}
                onChange={(e) => setPartner(e.target.value)}
              />
            </div>
            <div className="min-w-[220px] flex-1">
              <TextArea
                label="Notes"
                optional
                rows={1}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <Button
              variant="primary"
              disabled={!sel.size || create.isPending}
              loading={create.isPending}
              onClick={submit}
            >
              <Boxes className="h-4 w-4" /> Create shipment for {plural(sel.size, "order")}
            </Button>
            {create.error && (
              <p role="alert" className="w-full text-[13px] text-danger">
                {describeError(create.error)}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function Shipments() {
  const { isV360 } = useOps();
  const navigate = useNavigate();
  const [scope, setScope] = useState<"active" | "all">("active");
  const q = useShipments(scope);
  const create = useCreateShipment({ inlineErrors: true });
  const [creating, setCreating] = useState(false);
  const [partner, setPartner] = useState("");

  return (
    <>
      <PageHeader
        title={isV360 ? "Shipments" : "Incoming shipments"}
        description={isV360 ? "Consolidated shipments from the Lahore hub to KBB in Bangladesh. Pick the ready orders, then create a shipment for them." : "Shipments V360 has sent. Confirm receipt when a shipment reaches you; every order inside updates."}
        actions={<>
          <div role="radiogroup" className="flex rounded border border-line p-0.5 text-[13px]">
            {([["active", isV360 ? "Active" : "On the way"], ["all", "All"]] as const).map(([k, l]) => (
              <button key={k} role="radio" aria-checked={scope === k} onClick={() => setScope(k)} className={`rounded-[4px] px-3 py-1 ${scope === k ? "bg-sunken font-medium" : "text-muted"}`}>{l}</button>
            ))}
          </div>
          {isV360 && <Button variant="primary" onClick={() => { create.reset(); setPartner(""); setCreating(true); }}><Plus className="h-4 w-4" /> New shipment</Button>}
        </>} />

      {isV360 && <ShipmentBuilder onCreated={(id) => navigate(`/shipments/${id}`)} />}
      <datalist id="carriers">{["DHL", "Aramex", "FedEx", "TCS International", "Leopards International", "Cargo"].map((c) => <option key={c} value={c} />)}</datalist>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13.5px]">
            <thead className="table-head"><tr><th>Shipment</th><th>Carrier</th><th>Tracking</th><th className="text-right">Orders</th><th className="text-right">Brands</th><th className="text-right">COD value</th><th>Status</th><th>Left hub</th></tr></thead>
            {q.isLoading ? <SkeletonRows cols={8} rows={4} /> : (
              <tbody className="table-body">
                {q.data!.map((s) => (
                  <tr key={s.id} onClick={() => navigate(`/shipments/${s.id}`)} className="cursor-pointer hover:bg-sunken/50">
                    <td><Link to={`/shipments/${s.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold hover:underline">{s.code}</Link></td>
                    <td>{s.shipping_partner ?? "—"}</td>
                    <td className="text-muted">{s.tracking_number ?? "—"}</td>
                    <td className="text-right">{s.order_count}</td>
                    <td className="text-right">{s.brand_count}</td>
                    <td className="whitespace-nowrap text-right">{fmtMoney(s.cod_expected, "BDT")}</td>
                    <td><Pill {...SHIPMENT_STATUS[s.status]} /></td>
                    <td className="whitespace-nowrap text-muted">{fmtDateTime(s.dispatched_at)}</td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && q.data!.length === 0 && (
          <EmptyState icon={<Ship className="h-6 w-6" />} title={isV360 ? "No shipments" : "No shipments on the way"}>
            {isV360 ? "Pick the ready orders above to create a shipment." : "When V360 dispatches a shipment to you, it appears here."}
          </EmptyState>
        )}
      </div>

      <ActionDialog open={creating} onClose={() => setCreating(false)} busy={create.isPending} error={create.error ? describeError(create.error) : null}
        title="New shipment" description="It starts as a draft. Add ready orders next, then set tracking and dispatch it."
        confirmLabel="Create shipment" noteLabel="Notes"
        onConfirm={(notes) => create.mutate({ partner, notes }, { onSuccess: (id) => { setCreating(false); navigate(`/shipments/${id}`); } })}>
        <TextField label="Shipping partner" optional list="carriers" value={partner} onChange={(e) => setPartner(e.target.value)} autoFocus />
      </ActionDialog>
    </>
  );
}