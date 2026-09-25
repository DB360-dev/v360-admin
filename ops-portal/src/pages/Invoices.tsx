import { useMemo, useState } from "react";
import { Eye, Filter, Pencil, Plus, Printer, RefreshCw, Search, Trash2, Truck } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useDeleteInvoice, useInvoicesList, useShipments } from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { ActionDialog } from "@/components/ActionDialog";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { InvoicePaymentStatus, ShipmentOverview } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/States";
import { KbbInvoiceDialog, type InvoiceType } from "@/components/KbbInvoiceDialog";
import { GenerateInvoiceModal } from "@/components/GenerateInvoiceModal";
import { EditPaymentStatusModal } from "@/components/EditPaymentStatusModal";
import { BrandShippingInvoicesPanel } from "@/components/BrandShippingInvoicesPanel";

const byNewest = (a: { created_at: string }, b: { created_at: string }) =>
  new Date(b.created_at).getTime() - new Date(a.created_at).getTime();

export function Invoices() {
  const { isV360 } = useOps();
  const shipmentsQuery = useShipments("all");
  const invoicesQuery = useInvoicesList();
  
  const [search, setSearch] = useState("");
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  
  // Single/Multi shipment or custom order selection state for invoice modal
  const [selectedSingleShipment, setSelectedSingleShipment] = useState<ShipmentOverview | null>(null);
  const [selectedMultiShipments, setSelectedMultiShipments] = useState<ShipmentOverview[] | undefined>(undefined);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[] | undefined>(undefined);

  const [modalMode, setModalMode] = useState<"summary" | "detail">("summary");
  const [targetInvoiceType, setTargetInvoiceType] = useState<InvoiceType>("dispatch_advance");
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [generatorModalOpen, setGeneratorModalOpen] = useState(false);

  // Edit payment status modal state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editInvoiceNum, setEditInvoiceNum] = useState("");
  const [editInvoiceStatus, setEditInvoiceStatus] = useState<InvoicePaymentStatus>("not_paid");

  // Delete saved invoice (V360)
  const deleteInvoice = useDeleteInvoice({ inlineErrors: true });
  const [deletingInvoice, setDeletingInvoice] = useState<{ number: string; type: InvoiceType } | null>(null);
  const openDelete = (number: string, type: InvoiceType) => { deleteInvoice.reset(); setDeletingInvoice({ number, type }); };

  const shipments = shipmentsQuery.data ?? [];
  const savedInvoices = invoicesQuery.data ?? [];

  // Filtered 50% Dispatch Advance Invoices
  const dispatchInvoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    
    // Saved invoices of type dispatch_advance
    const savedDispatch = savedInvoices.filter((inv) => inv.invoice_type === "dispatch_advance");
    const savedInvNums = new Set(savedDispatch.map((i) => i.invoice_number));

    // Fallback shipments not explicitly saved yet
    const fallbackList = shipments
      .filter((s) => !savedInvNums.has(`INV-DISP-${s.code}`))
      .map((s) => ({
        id: s.id,
        invoice_number: `INV-DISP-${s.code}`,
        invoice_type: "dispatch_advance" as InvoiceType,
        shipment_ids: [s.id],
        order_ids: null,
        order_count: s.order_count,
        brand_count: s.brand_count,
        total_value: s.cod_expected || 0,
        advance_amount: 0.5 * (s.cod_expected || 0),
        net_remaining: 0.5 * (s.cod_expected || 0) - (s.cod_expected || 0) * 0.08,
        payable_amount: 0.5 * (s.cod_expected || 0) + (0.5 * (s.cod_expected || 0) - (s.cod_expected || 0) * 0.08),
        payment_status: s.invoice_payment_status || "not_paid",
        notes: null,
        created_at: s.dispatched_at || s.created_at,
        updated_at: s.created_at,
        shipmentRef: s.code,
        shipmentObj: s,
        saved: false,
      }));

    const allDispatch = [
      ...savedDispatch.map((inv) => ({
        ...inv,
        shipmentRef: inv.invoice_number.replace("INV-DISP-", ""),
        shipmentObj: shipments.find((s) => inv.shipment_ids?.includes(s.id)),
        saved: true,
      })),
      ...fallbackList,
    ];

    return allDispatch.filter((inv) => {
      const matchSearch =
        !q ||
        inv.invoice_number.toLowerCase().includes(q) ||
        inv.shipmentRef.toLowerCase().includes(q);
      const matchPayment = paymentFilter === "all" || inv.payment_status === paymentFilter;
      return matchSearch && matchPayment;
    }).sort(byNewest);
  }, [savedInvoices, shipments, search, paymentFilter]);

  // Filtered Final Settlement Invoices
  const settlementInvoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    const savedSettlement = savedInvoices.filter((inv) => inv.invoice_type === "final_settlement");

    return savedSettlement.filter((inv) => {
      const matchSearch = !q || inv.invoice_number.toLowerCase().includes(q);
      const matchPayment = paymentFilter === "all" || inv.payment_status === paymentFilter;
      return matchSearch && matchPayment;
    }).sort(byNewest);
  }, [savedInvoices, search, paymentFilter]);

  const openSingleInvoiceModal = (
    shipment: ShipmentOverview | null,
    orderIdsList: string[] | undefined,
    mode: "summary" | "detail",
    type: InvoiceType
  ) => {
    setSelectedSingleShipment(shipment);
    setSelectedMultiShipments(undefined);
    setSelectedOrderIds(orderIdsList);
    setModalMode(mode);
    setTargetInvoiceType(type);
    setInvoiceModalOpen(true);
  };

  const handleOpenEditPayment = (invoiceNum: string, status: InvoicePaymentStatus) => {
    setEditInvoiceNum(invoiceNum);
    setEditInvoiceStatus(status);
    setEditModalOpen(true);
  };

  const handleGenerateShipments = (shipmentsList: ShipmentOverview[], type: InvoiceType) => {
    setSelectedSingleShipment(null);
    setSelectedMultiShipments(shipmentsList);
    setSelectedOrderIds(undefined);
    setModalMode("detail");
    setTargetInvoiceType(type);
    setInvoiceModalOpen(true);
  };

  const handleGenerateOrders = (orderIdsList: string[], type: InvoiceType) => {
    setSelectedSingleShipment(null);
    setSelectedMultiShipments(undefined);
    setSelectedOrderIds(orderIdsList);
    setModalMode("detail");
    setTargetInvoiceType(type);
    setInvoiceModalOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Invoices & Payments"
        description="KBB dispatch advance & final settlement invoices, and brand shipping charges"
        actions={
          isV360 ? (
            <Button variant="primary" onClick={() => setGeneratorModalOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Generate Invoice
            </Button>
          ) : undefined
        }
      />

      {/* Filter & Search Bar */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 shadow-xs">
        <div className="flex min-w-[240px] flex-1 items-center gap-2">
          <Search className="h-4 w-4 text-muted shrink-0" />
          <input
            type="text"
            placeholder="Search by Invoice #, Shipment Code, Tracking, or Ref..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-transparent text-xs text-ink placeholder:text-muted focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-2 text-xs">
          <Filter className="h-3.5 w-3.5 text-muted" />
          <span className="text-muted font-medium">Payment Status:</span>
          <select
            value={paymentFilter}
            onChange={(e) => setPaymentFilter(e.target.value)}
            className="rounded border border-line bg-surface px-2.5 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">All Payment Statuses</option>
            <option value="not_paid">Unpaid (Not Paid)</option>
            <option value="partially_paid">Partially Paid</option>
            <option value="paid">Paid</option>
          </select>
        </div>
      </div>

      {shipmentsQuery.isLoading || invoicesQuery.isLoading ? (
        <Spinner label="Loading invoices dashboard..." />
      ) : (
        /* TWO COLUMNS LAYOUT FOR INVOICES */
        <div className="grid gap-6 lg:grid-cols-2">
          {/* COLUMN 1: 50% DISPATCH ADVANCE INVOICES */}
          <div className="rounded-lg border border-line bg-surface p-4 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <div className="grid h-8 w-8 place-items-center rounded bg-primary/10 text-primary">
                  <Truck className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-ink">50% Dispatch Advance Invoices</h2>
                  <p className="text-[11px] text-muted">Initial 50% advance charged upon dispatch</p>
                </div>
              </div>
              <span className="rounded bg-primary-soft/60 px-2 py-0.5 text-xs font-semibold text-primary">
                {dispatchInvoices.length} Invoices
              </span>
            </div>

            {dispatchInvoices.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted">No 50% Dispatch Advance invoices found.</p>
            ) : (
              <div className="max-h-[500px] overflow-y-auto rounded border border-line">
                <table className="w-full text-xs">
                  <thead className="table-head sticky top-0 bg-surface border-b border-line">
                    <tr>
                      <th>Invoice #</th>
                      <th>Ref</th>
                      <th>Date</th>
                      <th>Orders</th>
                      <th className="text-right">50% Advance (PKR)</th>
                      <th>Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="table-body divide-y divide-line">
                    {dispatchInvoices.map((inv) => (
                      <tr key={inv.id || inv.invoice_number} className="hover:bg-surface-hover/50">
                        <td className="font-semibold text-primary">{inv.invoice_number}</td>
                        <td className="text-ink font-medium">{inv.shipmentRef || "Custom"}</td>
                        <td className="text-muted whitespace-nowrap">{fmtDate(inv.created_at)}</td>
                        <td className="text-muted">{inv.order_count}</td>
                        <td className="text-right font-bold text-ink">
                          {fmtMoney(inv.advance_amount || 0.5 * inv.total_value, "PKR")}
                        </td>
                        <td>
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              inv.payment_status === "paid"
                                ? "bg-emerald-100 text-emerald-800"
                                : inv.payment_status === "partially_paid"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-rose-100 text-rose-800"
                            }`}
                          >
                            {inv.payment_status === "paid"
                              ? "Paid"
                              : inv.payment_status === "partially_paid"
                              ? "Partially Paid"
                              : "Unpaid"}
                          </span>
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                openSingleInvoiceModal(
                                  inv.shipmentObj || null,
                                  inv.order_ids || undefined,
                                  "summary",
                                  "dispatch_advance"
                                )
                              }
                              title="Summary View"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                openSingleInvoiceModal(
                                  inv.shipmentObj || null,
                                  inv.order_ids || undefined,
                                  "detail",
                                  "dispatch_advance"
                                )
                              }
                              title="Detailed PDF View"
                            >
                              <Printer className="h-3.5 w-3.5" />
                            </Button>
                            {isV360 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  handleOpenEditPayment(
                                    inv.invoice_number,
                                    inv.payment_status as InvoicePaymentStatus
                                  )
                                }
                                title="Edit Payment Status"
                              >
                                <Pencil className="h-3.5 w-3.5 text-muted hover:text-ink" />
                              </Button>
                            )}
                            {isV360 && inv.saved && (
                              <Button size="sm" variant="ghost" onClick={() => openDelete(inv.invoice_number, "dispatch_advance")}
                                title="Delete invoice" aria-label={`Delete ${inv.invoice_number}`}>
                                <Trash2 className="h-3.5 w-3.5 text-muted hover:text-g-problem" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* COLUMN 2: FINAL SETTLEMENT INVOICES */}
          <div className="rounded-lg border border-line bg-surface p-4 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <div className="grid h-8 w-8 place-items-center rounded bg-emerald-500/10 text-emerald-600">
                  <RefreshCw className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-ink">Final Settlement Invoices</h2>
                  <p className="text-[11px] text-muted">Delivered 50% Remaining & Returned Clawbacks</p>
                </div>
              </div>
              <span className="rounded bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-semibold">
                {settlementInvoices.length} Invoices
              </span>
            </div>

            {settlementInvoices.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted">No Final Settlement invoices generated yet.</p>
            ) : (
              <div className="max-h-[500px] overflow-y-auto rounded border border-line">
                <table className="w-full text-xs">
                  <thead className="table-head sticky top-0 bg-surface border-b border-line">
                    <tr>
                      <th>Invoice #</th>
                      <th>Date</th>
                      <th>Orders</th>
                      <th className="text-right">Net Payable (PKR)</th>
                      <th>Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="table-body divide-y divide-line">
                    {settlementInvoices.map((inv) => (
                      <tr key={inv.id} className="hover:bg-surface-hover/50">
                        <td className="font-semibold text-emerald-700">{inv.invoice_number}</td>
                        <td className="text-muted">{fmtDate(inv.created_at)}</td>
                        <td className="text-muted">{inv.order_count}</td>
                        <td className="text-right font-bold text-emerald-800">
                          {fmtMoney(inv.payable_amount, "PKR")}
                        </td>
                        <td>
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              inv.payment_status === "paid"
                                ? "bg-emerald-100 text-emerald-800"
                                : inv.payment_status === "partially_paid"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-rose-100 text-rose-800"
                            }`}
                          >
                            {inv.payment_status === "paid"
                              ? "Paid"
                              : inv.payment_status === "partially_paid"
                              ? "Partially Paid"
                              : "Unpaid"}
                          </span>
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                openSingleInvoiceModal(
                                  null,
                                  inv.order_ids || undefined,
                                  "summary",
                                  "final_settlement"
                                )
                              }
                              title="Summary View"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                openSingleInvoiceModal(
                                  null,
                                  inv.order_ids || undefined,
                                  "detail",
                                  "final_settlement"
                                )
                              }
                              title="Detailed PDF View"
                            >
                              <Printer className="h-3.5 w-3.5" />
                            </Button>
                            {isV360 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  handleOpenEditPayment(
                                    inv.invoice_number,
                                    inv.payment_status as InvoicePaymentStatus
                                  )
                                }
                                title="Edit Payment Status"
                              >
                                <Pencil className="h-3.5 w-3.5 text-muted hover:text-ink" />
                              </Button>
                            )}
                            {isV360 && (
                              <Button size="sm" variant="ghost" onClick={() => openDelete(inv.invoice_number, "final_settlement")}
                                title="Delete invoice" aria-label={`Delete ${inv.invoice_number}`}>
                                <Trash2 className="h-3.5 w-3.5 text-muted hover:text-g-problem" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <BrandShippingInvoicesPanel search={search} paymentFilter={paymentFilter} canEdit={isV360} />

      {/* Invoice Generator Selection Modal (V360 Only) */}
      {isV360 && (
        <GenerateInvoiceModal
          open={generatorModalOpen}
          onClose={() => setGeneratorModalOpen(false)}
          onGenerateShipments={handleGenerateShipments}
          onGenerateOrders={handleGenerateOrders}
        />
      )}

      {/* Invoice View / PDF Modal */}
      <KbbInvoiceDialog
        open={invoiceModalOpen}
        onClose={() => setInvoiceModalOpen(false)}
        shipment={selectedSingleShipment}
        shipments={selectedMultiShipments}
        orderIds={selectedOrderIds}
        initialMode={modalMode}
        initialInvoiceType={targetInvoiceType}
      />

      {/* Edit Payment Status Modal (V360 Only) */}
      {isV360 && (
        <EditPaymentStatusModal
          open={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          invoiceNumber={editInvoiceNum}
          currentStatus={editInvoiceStatus}
        />
      )}

      <ActionDialog open={!!deletingInvoice} onClose={() => setDeletingInvoice(null)} danger busy={deleteInvoice.isPending}
        error={deleteInvoice.error ? describeError(deleteInvoice.error) : null}
        title={`Delete ${deletingInvoice?.number ?? ""}?`}
        description={deletingInvoice?.type === "final_settlement"
          ? "Its orders go back to unsettled, so they can be included in a new final settlement invoice. This can't be undone."
          : "The saved invoice is removed and the shipment's advance payment status goes back to Unpaid. The shipment's 50% advance still shows here, calculated fresh, until a new invoice is saved."}
        confirmLabel="Delete invoice"
        onConfirm={() => deletingInvoice && deleteInvoice.mutate(deletingInvoice.number, { onSuccess: () => setDeletingInvoice(null) })} />
    </>
  );
}
