import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useBrandPayoutCandidates, useCreateBrandPayoutInvoice, useV360CommissionPcts } from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { fmtMoney, fmtShort } from "@/lib/format";
import { RETURNED_DISCREPANCY_LABEL, STATUS } from "@/lib/status";
import type { BrandPayoutCandidate } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";

const isDelivered = (o: BrandPayoutCandidate) => o.status === "delivered";

/** Pick one brand's KBB-settled delivered / returned orders and create its payout invoice. */
export function BrandPayoutPicker({ onBack, onCreated }: { onBack: () => void; onCreated: (invoiceNumber: string) => void }) {
  const q = useBrandPayoutCandidates();
  const pcts = useV360CommissionPcts();
  const create = useCreateBrandPayoutInvoice({ inlineErrors: true });
  const [open, setOpen] = useState<string | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const brands = useMemo(() => {
    const s = search.trim().toLowerCase();
    const m = new Map<string, { id: string; name: string; orders: BrandPayoutCandidate[] }>();
    for (const o of q.data ?? []) {
      if (s && !`${o.brand_name} ${o.order_number} ${o.customer_name ?? ""}`.toLowerCase().includes(s)) continue;
      const b = m.get(o.brand_id) ?? { id: o.brand_id, name: o.brand_name, orders: [] };
      b.orders.push(o);
      m.set(o.brand_id, b);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [q.data, search]);

  const pctFor = (id: string) => pcts.data?.byBrand[id] ?? pcts.data?.fallback ?? 15;

  // Orders from one brand per invoice: picking another brand starts a new selection.
  const toggle = (o: BrandPayoutCandidate) => {
    const next = new Set(brandId === o.brand_id ? sel : []);
    if (next.has(o.id)) next.delete(o.id); else next.add(o.id);
    setBrandId(next.size ? o.brand_id : null);
    setSel(next);
  };
  const toggleAll = (b: { id: string; orders: BrandPayoutCandidate[] }) => {
    const all = brandId === b.id && b.orders.every((o) => sel.has(o.id));
    setBrandId(all ? null : b.id);
    setSel(all ? new Set() : new Set(b.orders.map((o) => o.id)));
  };

  const chosen = (q.data ?? []).filter((o) => sel.has(o.id));
  const pct = brandId ? pctFor(brandId) : 0;
  const delivered = chosen.filter(isDelivered).reduce((n, o) => n + Number(o.order_value), 0);
  const returned = chosen.filter((o) => !isDelivered(o)).reduce((n, o) => n + Number(o.order_value), 0);
  const commission = (delivered * pct) / 100;
  const total = delivered + returned;
  const payable = total - commission - returned;

  if (q.isLoading || pcts.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Orders KBB has already settled (on a final settlement invoice) that are delivered or returned. Pay one brand per invoice:
        total parcels amount, less V360 commission on delivered orders, less the returned orders.
      </p>
      <label className="relative block sm:max-w-xs">
        <span className="sr-only">Search</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
        <input className="input pl-9" placeholder="Brand, order, customer" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>

      {brands.length === 0 ? (
        <EmptyState title="Nothing to pay out">Orders appear here once they're delivered or returned and on a KBB final settlement invoice.</EmptyState>
      ) : (
        <ul className="max-h-[420px] space-y-2 overflow-y-auto">
          {brands.map((b) => {
            const isOpen = open === b.id;
            const picked = brandId === b.id ? b.orders.filter((o) => sel.has(o.id)).length : 0;
            const nDel = b.orders.filter(isDelivered).length;
            return (
              <li key={b.id} className="rounded border border-line">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button type="button" onClick={() => setOpen(isOpen ? null : b.id)} aria-expanded={isOpen}
                    className="flex flex-1 items-center gap-2 text-left">
                    {isOpen ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronRight className="h-4 w-4 text-muted" />}
                    <span className="font-semibold">{b.name}</span>
                    <span className="text-[12.5px] text-muted">{nDel} delivered · {b.orders.length - nDel} returned · V360 {pctFor(b.id)}%</span>
                  </button>
                  {picked > 0 && <span className="text-[12.5px] font-medium text-primary">{picked} selected</span>}
                  <Button size="sm" variant="ghost" onClick={() => toggleAll(b)}>
                    {brandId === b.id && picked === b.orders.length ? "Clear" : "Select all"}
                  </Button>
                </div>
                {isOpen && (
                  <ul className="divide-y divide-line border-t border-line">
                    {b.orders.map((o) => (
                      <li key={o.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] hover:bg-sunken/50">
                          <input type="checkbox" checked={sel.has(o.id)} onChange={() => toggle(o)} />
                          <span className="w-24 font-medium">{o.order_number}</span>
                          <span className="w-20 text-faint">{fmtShort(o.order_date)}</span>
                          <span className="min-w-0 flex-1 truncate text-muted">{o.customer_name ?? "—"}{o.city ? `, ${o.city}` : ""}</span>
                          <Pill group={STATUS[o.status]?.group ?? "closed"}
                            label={o.status === "returned" && o.returned_due_to_discrepancy ? RETURNED_DISCREPANCY_LABEL : STATUS[o.status]?.label ?? o.status} />
                          <span className="w-28 text-right tabular-nums">{fmtMoney(o.order_value, "PKR")}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {chosen.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-line bg-sunken/40 px-3 py-2 text-[13px]">
          <dt className="text-muted">Total parcels amount</dt><dd className="text-right tabular-nums">{fmtMoney(total, "PKR")}</dd>
          <dt className="text-muted">− V360 commission ({pct}% on delivered)</dt><dd className="text-right tabular-nums">−{fmtMoney(commission, "PKR")}</dd>
          <dt className="text-muted">− Total return orders</dt><dd className="text-right tabular-nums">−{fmtMoney(returned, "PKR")}</dd>
          <dt className="font-semibold">Payable to brand</dt><dd className="text-right font-semibold tabular-nums">{fmtMoney(payable, "PKR")}</dd>
        </dl>
      )}
      {create.error && <p className="text-[13px] text-g-problem">{describeError(create.error)}</p>}

      <div className="flex items-center justify-between border-t border-line pt-3">
        <Button size="sm" variant="ghost" onClick={onBack}>&larr; Back</Button>
        <Button variant="primary" disabled={!brandId || !chosen.length} loading={create.isPending}
          onClick={() => brandId && create.mutate({ brandId, orderIds: [...sel] }, { onSuccess: (n) => onCreated(n) })}>
          Generate brand invoice ({chosen.length})
        </Button>
      </div>
    </div>
  );
}
