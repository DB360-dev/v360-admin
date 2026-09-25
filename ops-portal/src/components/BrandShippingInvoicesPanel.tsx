import { useMemo, useState } from "react";
import { Package, Printer, Trash2 } from "lucide-react";
import { useBrandShippingInvoices, useDeleteShippingInvoice, useSetShippingInvoicePaymentStatus } from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { ActionDialog } from "@/components/ActionDialog";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { BrandShippingInvoice, InvoicePaymentStatus } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ErrorState, Spinner } from "@/components/ui/States";
import { ShippingInvoiceDialog } from "@/components/ShippingInvoiceDialog";

const STATUS_STYLE: Record<InvoicePaymentStatus, string> = {
  paid: "bg-emerald-100 text-emerald-800",
  partially_paid: "bg-amber-100 text-amber-800",
  not_paid: "bg-rose-100 text-rose-800",
};
const STATUS_LABEL: Record<InvoicePaymentStatus, string> = { paid: "Paid", partially_paid: "Partially Paid", not_paid: "Unpaid" };

/** Brand shipping-charges invoices (one per brand per shipment, Pakistan-fulfilled units only). */
export function BrandShippingInvoicesPanel({ search, paymentFilter, canEdit }: { search: string; paymentFilter: string; canEdit: boolean }) {
  const q = useBrandShippingInvoices();
  const setStatus = useSetShippingInvoicePaymentStatus();
  const [viewing, setViewing] = useState<BrandShippingInvoice | null>(null);
  const del = useDeleteShippingInvoice({ inlineErrors: true });
  const [deleting, setDeleting] = useState<BrandShippingInvoice | null>(null);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((inv) =>
      (!s || [inv.invoice_number, inv.shipment?.code, inv.brand?.name].some((v) => v?.toLowerCase().includes(s)))
      && (paymentFilter === "all" || inv.payment_status === paymentFilter))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [q.data, search, paymentFilter]);

  return (
    <div className="mt-6 space-y-3 rounded-lg border border-line bg-surface p-4 shadow-xs">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded bg-sky-500/10 text-sky-600"><Package className="h-4 w-4" /></div>
          <div>
            <h2 className="text-sm font-bold text-ink">Brand Shipping Charges</h2>
            <p className="text-[11px] text-muted">One per brand per shipment, created on hand-over to the carrier. Pakistan-fulfilled units only.</p>
          </div>
        </div>
        <span className="rounded bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800">{rows.length} Invoices</span>
      </div>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted">No shipping-charges invoices yet.</p>
      ) : (
        <div className="max-h-[500px] overflow-auto rounded border border-line">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="table-head sticky top-0 border-b border-line bg-surface">
              <tr><th>Invoice #</th><th>Brand</th><th>Shipment</th><th>Date</th><th className="text-right">Units</th>
                <th className="text-right">Weight</th><th className="text-right">Amount (PKR)</th><th>Status</th><th className="text-right">Actions</th></tr>
            </thead>
            <tbody className="table-body divide-y divide-line">
              {rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface-hover/50">
                  <td className="font-semibold text-sky-700">{inv.invoice_number}</td>
                  <td className="font-medium text-ink">{inv.brand?.name}</td>
                  <td className="text-muted">{inv.shipment?.code}</td>
                  <td className="text-muted">{fmtDate(inv.created_at)}</td>
                  <td className="text-right text-muted">{inv.pk_units}{inv.bd_units > 0 && <span className="text-faint"> (+{inv.bd_units} BD)</span>}</td>
                  <td className="text-right text-muted">{Number(inv.weight_kg)} kg</td>
                  <td className="text-right font-bold text-ink">{fmtMoney(inv.amount_pkr, "PKR")}</td>
                  <td>
                    {canEdit ? (
                      <select aria-label={`Payment status for ${inv.invoice_number}`} value={inv.payment_status}
                        disabled={setStatus.isPending}
                        onChange={(e) => setStatus.mutate({ invoiceId: inv.id, status: e.target.value as InvoicePaymentStatus })}
                        className={`rounded border-0 px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[inv.payment_status]}`}>
                        {(Object.keys(STATUS_LABEL) as InvoicePaymentStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
                      </select>
                    ) : (
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[inv.payment_status]}`}>{STATUS_LABEL[inv.payment_status]}</span>
                    )}
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => setViewing(inv)} title="View / print"><Printer className="h-3.5 w-3.5" /></Button>
                      {canEdit && <Button size="sm" variant="ghost" onClick={() => { del.reset(); setDeleting(inv); }} title="Delete invoice" aria-label={`Delete ${inv.invoice_number}`}><Trash2 className="h-3.5 w-3.5 text-muted hover:text-g-problem" /></Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ShippingInvoiceDialog invoice={viewing} onClose={() => setViewing(null)} />
      <ActionDialog open={!!deleting} onClose={() => setDeleting(null)} danger busy={del.isPending}
        error={del.error ? describeError(del.error) : null}
        title={`Delete ${deleting?.invoice_number ?? ""}?`}
        description={deleting ? `${deleting.brand?.name ?? "Brand"}, shipment ${deleting.shipment?.code ?? ""}. This can't be undone; "Recalculate invoices" on the shipment creates a fresh one.` : undefined}
        confirmLabel="Delete invoice"
        onConfirm={() => deleting && del.mutate(deleting.id, { onSuccess: () => setDeleting(null) })} />
    </div>
  );
}
