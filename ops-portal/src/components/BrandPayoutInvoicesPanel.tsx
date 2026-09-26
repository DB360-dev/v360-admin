import { useEffect, useMemo, useState } from "react";
import { HandCoins, Pencil, Printer, Trash2 } from "lucide-react";
import { useBrands } from "@/hooks/useData";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { InvoicePaymentStatus, InvoiceRecord } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { BrandPayoutInvoiceDialog } from "@/components/BrandPayoutInvoiceDialog";

const STATUS_STYLE: Record<InvoicePaymentStatus, string> = {
  paid: "bg-emerald-100 text-emerald-800",
  partially_paid: "bg-amber-100 text-amber-800",
  not_paid: "bg-rose-100 text-rose-800",
};
const STATUS_LABEL: Record<InvoicePaymentStatus, string> = { paid: "Paid", partially_paid: "Partially Paid", not_paid: "Unpaid" };

/** Brand payout invoices (V360 → brand), newest first. */
export function BrandPayoutInvoicesPanel({ invoices, search, paymentFilter, canEdit, openNumber, onOpened, onEditPayment, onDelete }: {
  invoices: InvoiceRecord[]; search: string; paymentFilter: string; canEdit: boolean;
  /** Open this invoice once it's loaded (e.g. just created). */
  openNumber?: string | null; onOpened?: () => void;
  onEditPayment: (number: string, status: InvoicePaymentStatus) => void;
  onDelete: (number: string) => void;
}) {
  const brands = useBrands();
  const [viewing, setViewing] = useState<InvoiceRecord | null>(null);
  const brandName = (id?: string | null) => brands.data?.find((b) => b.id === id)?.name ?? "—";

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return invoices
      .filter((i) => i.invoice_type === "brand_payout")
      .filter((i) => (!s || `${i.invoice_number} ${brandName(i.brand_id)}`.toLowerCase().includes(s))
        && (paymentFilter === "all" || i.payment_status === paymentFilter))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [invoices, search, paymentFilter, brands.data]);

  useEffect(() => {
    if (!openNumber) return;
    const inv = invoices.find((i) => i.invoice_number === openNumber);
    if (inv) { setViewing(inv); onOpened?.(); }
  }, [openNumber, invoices]);

  return (
    <div className="mt-6 space-y-3 rounded-lg border border-line bg-surface p-4 shadow-xs">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded bg-violet-500/10 text-violet-600"><HandCoins className="h-4 w-4" /></div>
          <div>
            <h2 className="text-sm font-bold text-ink">Brand Payout Invoices</h2>
            <p className="text-[11px] text-muted">Total parcels amount, less V360 commission on delivered orders and less returned orders. Only orders KBB has settled.</p>
          </div>
        </div>
        <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">{rows.length} Invoices</span>
      </div>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted">No brand payout invoices yet. Use Generate Invoice → Generate Invoice for Brand.</p>
      ) : (
        <div className="max-h-[500px] overflow-auto rounded border border-line">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="table-head sticky top-0 border-b border-line bg-surface">
              <tr><th>Invoice #</th><th>Brand</th><th>Date</th><th>Orders</th><th className="text-right">Payable (PKR)</th><th>Status</th><th className="text-right">Actions</th></tr>
            </thead>
            <tbody className="table-body divide-y divide-line">
              {rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface-hover/50">
                  <td className="font-semibold text-violet-700">{inv.invoice_number}</td>
                  <td className="font-medium text-ink">{brandName(inv.brand_id)}</td>
                  <td className="whitespace-nowrap text-muted">{fmtDate(inv.created_at)}</td>
                  <td className="text-muted">{inv.order_count}</td>
                  <td className="text-right font-bold text-ink">{fmtMoney(inv.payable_amount, "PKR")}</td>
                  <td><span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[inv.payment_status]}`}>{STATUS_LABEL[inv.payment_status]}</span></td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => setViewing(inv)} title="View / print"><Printer className="h-3.5 w-3.5" /></Button>
                      {canEdit && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => onEditPayment(inv.invoice_number, inv.payment_status)} title="Edit Payment Status">
                            <Pencil className="h-3.5 w-3.5 text-muted hover:text-ink" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onDelete(inv.invoice_number)} title="Delete invoice" aria-label={`Delete ${inv.invoice_number}`}>
                            <Trash2 className="h-3.5 w-3.5 text-muted hover:text-g-problem" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <BrandPayoutInvoiceDialog invoice={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
