import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Eye, Filter, Plus, Printer, Search } from "lucide-react";
import { useShipments, useUpdateInvoicePaymentStatus } from "@/hooks/useData";
import { SHIPMENT_STATUS } from "@/lib/status";
import { fmtDate, fmtMoney, plural } from "@/lib/format";
import type { InvoicePaymentStatus, ShipmentOverview, ShipmentStatus as ShipmentStatusType } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";
import { KbbInvoiceDialog } from "@/components/KbbInvoiceDialog";
import { GenerateInvoiceModal } from "@/components/GenerateInvoiceModal";

export function Invoices() {
  const shipmentsQuery = useShipments("all");
  const updatePaymentStatus = useUpdateInvoicePaymentStatus();
  
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  
  // Single/Multi shipment or custom order selection state for invoice modal
  const [selectedSingleShipment, setSelectedSingleShipment] = useState<ShipmentOverview | null>(null);
  const [selectedMultiShipments, setSelectedMultiShipments] = useState<ShipmentOverview[] | undefined>(undefined);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[] | undefined>(undefined);

  const [modalMode, setModalMode] = useState<"summary" | "detail">("summary");
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [generatorModalOpen, setGeneratorModalOpen] = useState(false);

  const shipments = shipmentsQuery.data ?? [];

  // Filtered shipments
  const filtered = useMemo(() => {
    return shipments.filter((s) => {
      const q = search.trim().toLowerCase();
      const matchSearch =
        !q ||
        s.code.toLowerCase().includes(q) ||
        `inv-kbb-${s.code}`.toLowerCase().includes(q) ||
        (s.shipping_partner && s.shipping_partner.toLowerCase().includes(q)) ||
        (s.tracking_number && s.tracking_number.toLowerCase().includes(q));

      const matchStatus = statusFilter === "all" || s.status === statusFilter;
      const currentPayStatus = s.invoice_payment_status || "not_paid";
      const matchPayment = paymentFilter === "all" || currentPayStatus === paymentFilter;

      return matchSearch && matchStatus && matchPayment;
    });
  }, [shipments, search, statusFilter, paymentFilter]);

  const openSingleInvoiceModal = (shipment: ShipmentOverview, mode: "summary" | "detail") => {
    setSelectedSingleShipment(shipment);
    setSelectedMultiShipments(undefined);
    setSelectedOrderIds(undefined);
    setModalMode(mode);
    setInvoiceModalOpen(true);
  };

  const handleGenerateShipments = (shipmentsList: ShipmentOverview[]) => {
    setSelectedSingleShipment(null);
    setSelectedMultiShipments(shipmentsList);
    setSelectedOrderIds(undefined);
    setModalMode("detail");
    setInvoiceModalOpen(true);
  };

  const handleGenerateOrders = (orderIdsList: string[]) => {
    setSelectedSingleShipment(null);
    setSelectedMultiShipments(undefined);
    setSelectedOrderIds(orderIdsList);
    setModalMode("detail");
    setInvoiceModalOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Invoices & Payments"
        description="Shipment dispatch advance invoices, fulfillment payment schedules, and brand breakdowns."
        actions={
          <Button variant="primary" onClick={() => setGeneratorModalOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Generate Invoice
          </Button>
        }
      />

      {/* Filter & Search Bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 shadow-xs">
        <div className="flex min-w-[240px] flex-1 items-center gap-2">
          <Search className="h-4 w-4 text-muted shrink-0" />
          <input
            type="text"
            placeholder="Search by Invoice #, Shipment Code, Tracking, or Carrier..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-transparent text-xs text-ink placeholder:text-muted focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Filter className="h-3.5 w-3.5" /> Filter Status:
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="input text-xs py-1 px-2 h-8"
          >
            <option value="all">All Shipment Statuses</option>
            <option value="ready_for_dispatch">Ready to dispatch</option>
            <option value="handed_to_carrier">Handed to carrier</option>
            <option value="in_transit">In transit</option>
            <option value="customs">Customs</option>
            <option value="arrived_bd">Arrived BD</option>
            <option value="received_by_partner">Received by KBB</option>
          </select>

          <select
            value={paymentFilter}
            onChange={(e) => setPaymentFilter(e.target.value)}
            className="input text-xs py-1 px-2 h-8"
          >
            <option value="all">All Payment Statuses</option>
            <option value="not_paid">Not Paid (Unpaid)</option>
            <option value="partially_paid">Partially Paid</option>
            <option value="paid">Paid</option>
          </select>
        </div>
      </div>

      {/* Invoices Table */}
      {shipmentsQuery.isLoading ? (
        <Spinner label="Loading invoices" />
      ) : shipmentsQuery.isError ? (
        <ErrorState error={shipmentsQuery.error} onRetry={() => shipmentsQuery.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState title="No invoices found">
          {search || statusFilter !== "all" || paymentFilter !== "all"
            ? "No invoices match your search or filter criteria."
            : "Dispatched shipments will automatically list invoices here."}
        </EmptyState>
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead className="table-head">
                <tr>
                  <th>Invoice #</th>
                  <th>Date</th>
                  <th>Shipment</th>
                  <th>Carrier & Tracking</th>
                  <th className="text-center">Orders</th>
                  <th className="text-right">Shipment Value</th>
                  <th className="text-right">50% Advance</th>
                  <th>Payment Status</th>
                  <th>Shipment Status</th>
                  <th className="text-right">Invoice Options</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {filtered.map((s) => {
                  const invNo = `INV-KBB-${s.code}`;
                  const issueDate = s.dispatched_at ? fmtDate(s.dispatched_at) : fmtDate(s.created_at);
                  const estAdvance = s.cod_expected ? s.cod_expected * 0.5 : 0;
                  const payStatus: InvoicePaymentStatus = s.invoice_payment_status || "not_paid";

                  return (
                    <tr key={s.id} className="hover:bg-surface-hover/50">
                      <td className="font-mono text-xs font-semibold text-primary">
                        {invNo}
                      </td>
                      <td className="whitespace-nowrap text-muted text-xs">
                        {issueDate}
                      </td>
                      <td>
                        <Link to={`/shipments/${s.id}`} className="font-semibold text-ink hover:underline">
                          {s.code}
                        </Link>
                        <div className="text-[11.5px] text-muted">{s.origin} &rarr; {s.destination}</div>
                      </td>
                      <td>
                        <div className="font-medium text-ink">{s.shipping_partner || "Carrier N/A"}</div>
                        <div className="text-[11.5px] font-mono text-muted">{s.tracking_number || "No tracking"}</div>
                      </td>
                      <td className="text-center font-medium">
                        {s.order_count}
                        <span className="block text-[11px] text-muted">({plural(s.brand_count, "brand")})</span>
                      </td>
                      <td className="whitespace-nowrap text-right font-medium text-ink">
                        {fmtMoney(s.cod_expected, "PKR")}
                      </td>
                      <td className="whitespace-nowrap text-right font-semibold text-emerald-700">
                        {fmtMoney(estAdvance, "PKR")}
                      </td>
                      <td>
                        {/* Payment Status Dropdown */}
                        <select
                          value={payStatus}
                          disabled={updatePaymentStatus.isPending}
                          onChange={(e) =>
                            updatePaymentStatus.mutate({
                              shipmentId: s.id,
                              status: e.target.value as InvoicePaymentStatus,
                            })
                          }
                          className={`rounded border px-2 py-1 text-xs font-semibold transition-colors focus:outline-none ${
                            payStatus === "paid"
                              ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                              : payStatus === "partially_paid"
                              ? "border-amber-400 bg-amber-50 text-amber-800"
                              : "border-slate-300 bg-slate-100 text-slate-700"
                          }`}
                        >
                          <option value="not_paid">Not Paid</option>
                          <option value="partially_paid">Partially Paid</option>
                          <option value="paid">Paid</option>
                        </select>
                      </td>
                      <td>
                        <Pill {...SHIPMENT_STATUS[s.status as ShipmentStatusType]} />
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <div className="flex justify-end items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openSingleInvoiceModal(s, "summary")}
                            title="View Summary Breakdown"
                          >
                            <Eye className="h-3.5 w-3.5 mr-1" /> Summary
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => openSingleInvoiceModal(s, "detail")}
                            title="View & Print 2-Page Detailed Invoice PDF"
                          >
                            <Printer className="h-3.5 w-3.5 mr-1" /> Detailed PDF
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Invoice Generator Selection Modal */}
      <GenerateInvoiceModal
        open={generatorModalOpen}
        onClose={() => setGeneratorModalOpen(false)}
        onGenerateShipments={handleGenerateShipments}
        onGenerateOrders={handleGenerateOrders}
      />

      {/* Invoice View / PDF Modal */}
      <KbbInvoiceDialog
        open={invoiceModalOpen}
        onClose={() => setInvoiceModalOpen(false)}
        shipment={selectedSingleShipment}
        shipments={selectedMultiShipments}
        orderIds={selectedOrderIds}
        initialMode={modalMode}
      />
    </>
  );
}
