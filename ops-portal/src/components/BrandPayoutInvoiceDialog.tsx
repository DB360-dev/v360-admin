import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { useBrands, useMoneySettings } from "@/hooks/useData";
import { fmtDate } from "@/lib/format";
import { RETURNED_DISCREPANCY_LABEL, STATUS } from "@/lib/status";
import type { InvoiceRecord } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

const num = (v: number) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAYMENT_LABEL = { not_paid: "Unpaid", partially_paid: "Partially paid", paid: "Paid" } as const;

/** Printable brand payout invoice, from the per-order snapshot saved with it. */
export function BrandPayoutInvoiceDialog({ invoice, onClose }: { invoice: InvoiceRecord | null; onClose: () => void }) {
  const money = useMoneySettings();
  const brands = useBrands();
  const [mode, setMode] = useState<"summary" | "detail">("summary");
  useEffect(() => { if (invoice) setMode("summary"); }, [invoice?.id]);
  if (!invoice) return null;
  const l = invoice.lines;
  const companyName = money.data?.invoice_company_name || "V360";
  const brandName = brands.data?.find((b) => b.id === invoice.brand_id)?.name ?? "Brand";
  const orders = l?.orders ?? [];
  const delivered = orders.filter((o) => o.status === "delivered");
  const returned = orders.filter((o) => o.status !== "delivered");
  const pct = l?.v360_commission_pct ?? 0;
  const commission = invoice.net_remaining;      // stored: V360 commission on delivered orders
  const returnedAmount = invoice.advance_amount; // stored: returned orders' amount deducted

  return (
    <Dialog open onClose={onClose} width="lg" title={`Brand invoice ${invoice.invoice_number}`}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={() => window.print()}><Printer className="mr-1.5 h-4 w-4" /> Save as PDF / Print</Button>
      </>}>
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 10mm 12mm; }
          html, body { background: #fff !important; height: auto !important; overflow: visible !important; }
          body * { visibility: hidden !important; }
          dialog { position: static !important; display: block !important; width: 100% !important; max-width: none !important;
            max-height: none !important; margin: 0 !important; padding: 0 !important; border: none !important;
            box-shadow: none !important; background: transparent !important; overflow: visible !important; }
          dialog::backdrop { display: none !important; }
          #brand-payout-print-area, #brand-payout-print-area * { visibility: visible !important; }
          #brand-payout-print-area { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important;
            border: none !important; box-shadow: none !important; }
        }
      `}</style>
      <div className="mb-3 flex gap-1 print:hidden" role="tablist">
        {(["summary", "detail"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={`rounded px-3 py-1 text-[13px] ${mode === m ? "bg-sunken font-medium" : "text-muted hover:text-ink"}`}>
            {m === "summary" ? "Summary" : "Detail"}
          </button>
        ))}
      </div>
      <div id="brand-payout-print-area" className="rounded-lg border border-slate-300 bg-white p-6 font-sans text-slate-900 sm:p-8">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{companyName}</h1>
            <p className="mt-0.5 text-xs text-slate-600">Brand payout: delivered and returned orders settled by KBB</p>
          </div>
          <div className="text-right text-xs">
            <p className="text-lg font-bold">BRAND PAYOUT INVOICE{mode === "detail" ? " — DETAIL" : ""}</p>
            <p className="font-semibold">{invoice.invoice_number}</p>
            <p className="text-slate-600">Date: {fmtDate(invoice.created_at)}</p>
            <p className="text-slate-600">Status: {PAYMENT_LABEL[invoice.payment_status]}</p>
          </div>
        </div>

        <div className="mb-5 text-xs">
          <p className="font-bold uppercase tracking-wider text-slate-500">Payable to</p>
          <p className="mt-1 text-sm font-semibold">{brandName}</p>
          <p className="text-slate-600">{delivered.length} delivered · {returned.length} returned</p>
        </div>

        {mode === "summary" ? (
          <table className="w-full max-w-md border-collapse border border-slate-300 text-sm">
            <tbody>
              <tr><td className="border border-slate-300 px-3 py-2">Total parcels amount ({orders.length})</td>
                <td className="border border-slate-300 px-3 py-2 text-right">{num(invoice.total_value)}</td></tr>
              <tr><td className="border border-slate-300 px-3 py-2">V360 commission ({pct}% on delivered)</td>
                <td className="border border-slate-300 px-3 py-2 text-right">−{num(commission)}</td></tr>
              <tr><td className="border border-slate-300 px-3 py-2">Total return orders ({returned.length})</td>
                <td className="border border-slate-300 px-3 py-2 text-right">−{num(returnedAmount)}</td></tr>
              <tr className="bg-slate-100 font-bold"><td className="border border-slate-300 px-3 py-2">Total payable to brand</td>
                <td className="border border-slate-300 px-3 py-2 text-right">{num(invoice.payable_amount)} PKR</td></tr>
            </tbody>
          </table>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse border border-slate-300 text-xs">
              <thead>
                <tr className="bg-slate-50 font-bold text-slate-800">
                  <th className="border border-slate-300 px-2.5 py-1.5 text-left">Order #</th>
                  <th className="border border-slate-300 px-2.5 py-1.5 text-left">Items</th>
                  <th className="border border-slate-300 px-2.5 py-1.5 text-left">Status</th>
                  <th className="border border-slate-300 px-2.5 py-1.5 text-right">Amount</th>
                  <th className="border border-slate-300 px-2.5 py-1.5 text-right">V360 commission</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.order_id} className="align-top">
                    <td className="border border-slate-300 px-2.5 py-1.5 font-medium">
                      {o.order_number}
                      {o.order_date && <div className="font-normal text-slate-500">{fmtDate(o.order_date)}</div>}
                    </td>
                    <td className="border border-slate-300 px-2.5 py-1.5">
                      {o.items?.length ? o.items.map((i, k) => (
                        <div key={k}>{i.quantity}× {i.product_name}{i.variant ? `, ${i.variant}` : ""}{i.sku ? <span className="text-slate-500"> · {i.sku}</span> : null}</div>
                      )) : <span className="text-slate-500">—</span>}
                    </td>
                    <td className="border border-slate-300 px-2.5 py-1.5">
                      {o.status === "returned" && o.returned_due_to_discrepancy ? RETURNED_DISCREPANCY_LABEL : STATUS[o.status]?.label ?? o.status}
                    </td>
                    <td className="border border-slate-300 px-2.5 py-1.5 text-right">{num(o.value)}</td>
                    <td className="border border-slate-300 px-2.5 py-1.5 text-right">{num(o.commission)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-100 font-bold">
                  <td colSpan={3} className="border border-slate-300 px-2.5 py-2 text-right">Total COD amount</td>
                  <td className="border border-slate-300 px-2.5 py-2 text-right">{num(invoice.total_value)}</td>
                  <td className="border border-slate-300 px-2.5 py-2 text-right">{num(commission)}</td>
                </tr>
              </tfoot>
            </table>
            <p className="mt-2 text-[11px] text-slate-500">V360 commission is {pct}% on delivered orders; returned orders carry no commission.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
