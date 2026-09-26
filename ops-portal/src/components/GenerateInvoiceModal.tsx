import { useMemo, useState } from "react";
import { ChevronDown, Filter, HandCoins, Package, RefreshCw, Search, Ship, Truck, X } from "lucide-react";
import { BrandPayoutPicker } from "@/components/BrandPayoutPicker";
import { useOrderList, useShipments } from "@/hooks/useData";
import { fmtDate, fmtMoney } from "@/lib/format";
import { SHIPMENT_STATUS, STATUS } from "@/lib/status";
import type { OrderStatus, ShipmentOverview, ShipmentStatus as ShipmentStatusType } from "@/lib/types";
import type { InvoiceType } from "@/components/KbbInvoiceDialog";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Pill } from "@/components/ui/StatusBadge";
import { Spinner } from "@/components/ui/States";

interface GenerateInvoiceModalProps {
  open: boolean;
  onClose: () => void;
  onGenerateShipments: (shipments: ShipmentOverview[], invoiceType: InvoiceType) => void;
  onGenerateOrders: (orderIds: string[], invoiceType: InvoiceType) => void;
  /** A brand payout invoice was created (saved already). */
  onBrandInvoiceCreated: (invoiceNumber: string) => void;
}

type Step = "choose" | "by_shipments" | "by_orders" | "by_brand";

const ALL_STATUS_OPTIONS: { value: OrderStatus; label: string; group: string }[] = [
  { value: "ready_for_shipment", label: "Ready for shipment", group: "V360 Hub" },
  { value: "assigned_to_shipment", label: "In a shipment", group: "V360 Hub" },
  { value: "dispatched_to_hub", label: "Dispatched to hub", group: "V360 Hub" },
  { value: "received_at_hub", label: "Received at hub", group: "V360 Hub" },
  { value: "shipped", label: "Shipped", group: "In Transit" },
  { value: "in_transit", label: "In transit", group: "In Transit" },
  { value: "customs", label: "Customs / clearance", group: "In Transit" },
  { value: "arrived_bd", label: "Arrived in Bangladesh", group: "In Transit" },
  { value: "received_by_partner", label: "Received by KBB", group: "KBB Delivery" },
  { value: "preparing_for_delivery", label: "Preparing for delivery", group: "KBB Delivery" },
  { value: "out_for_delivery", label: "Out for delivery", group: "KBB Delivery" },
  { value: "delivered", label: "Delivered", group: "Delivered" },
  { value: "brand_preparing", label: "Brand preparing", group: "Brand" },
  { value: "brand_confirmed", label: "Brand confirmed", group: "Brand" },
  { value: "confirmed", label: "Confirmed", group: "Brand" },
  { value: "needs_amendment", label: "Needs amendment", group: "Brand" },
  { value: "new", label: "New", group: "Initial" },
  { value: "confirmation_pending", label: "Confirmation pending", group: "Initial" },
  { value: "customer_unreachable", label: "Customer unreachable", group: "Initial" },
  { value: "hub_issue", label: "Hub issue", group: "Problems" },
  { value: "delivery_failed", label: "Delivery failed", group: "Problems" },
  { value: "returned", label: "Returned", group: "Problems" },
  { value: "hold", label: "On hold", group: "Problems" },
  { value: "cancelled", label: "Cancelled", group: "Closed" },
];

export function GenerateInvoiceModal({
  open,
  onClose,
  onGenerateShipments,
  onGenerateOrders,
  onBrandInvoiceCreated,
}: GenerateInvoiceModalProps) {
  const [step, setStep] = useState<Step>("choose");
  const [targetInvoiceType, setTargetInvoiceType] = useState<InvoiceType>("dispatch_advance");

  // Shipment selection state
  const shipmentsQuery = useShipments("all");
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<Set<string>>(new Set());
  const [shipmentSearch, setShipmentSearch] = useState("");

  // Order selection state
  const [orderSearch, setOrderSearch] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<OrderStatus[]>([]);
  const [showStatusFilterMenu, setShowStatusFilterMenu] = useState(false);

  const ordersQuery = useOrderList({
    statuses: targetInvoiceType === "final_settlement"
      ? ["delivered", "returned", "delivery_failed", "cancelled"]
      : (selectedStatuses.length > 0 ? selectedStatuses : null),
    search: orderSearch || undefined,
    limit: 500,
  });
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());

  // Reset state on open
  const handleClose = () => {
    setStep("choose");
    setTargetInvoiceType("dispatch_advance");
    setSelectedShipmentIds(new Set());
    setSelectedOrderIds(new Set());
    setShipmentSearch("");
    setOrderSearch("");
    setSelectedStatuses([]);
    setShowStatusFilterMenu(false);
    onClose();
  };

  const allShipments = shipmentsQuery.data ?? [];
  const filteredShipments = useMemo(() => {
    let list = allShipments;
    if (targetInvoiceType === "final_settlement") {
      list = list.filter((s) => !s.is_settled && s.invoice_payment_status === "paid");
    }
    const q = shipmentSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.code.toLowerCase().includes(q) ||
        (s.shipping_partner && s.shipping_partner.toLowerCase().includes(q)) ||
        (s.tracking_number && s.tracking_number.toLowerCase().includes(q))
    );
  }, [allShipments, shipmentSearch, targetInvoiceType]);

  const toggleShipment = (id: string) => {
    setSelectedShipmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllShipments = () => {
    if (selectedShipmentIds.size === filteredShipments.length && filteredShipments.length > 0) {
      setSelectedShipmentIds(new Set());
    } else {
      setSelectedShipmentIds(new Set(filteredShipments.map((s) => s.id)));
    }
  };

  const selectedShipmentsList = useMemo(() => {
    return allShipments.filter((s) => selectedShipmentIds.has(s.id));
  }, [allShipments, selectedShipmentIds]);

  const selectedShipmentsOrdersSum = useMemo(() => {
    return selectedShipmentsList.reduce((acc, s) => acc + s.order_count, 0);
  }, [selectedShipmentsList]);

  const selectedShipmentsValueSum = useMemo(() => {
    return selectedShipmentsList.reduce((acc, s) => acc + (s.cod_expected || 0), 0);
  }, [selectedShipmentsList]);

  // Orders selection calculations
  const rawOrders = ordersQuery.data?.rows ?? [];
  const allOrders = useMemo(() => {
    if (targetInvoiceType === "final_settlement") {
      return rawOrders.filter((o) => {
        if (o.is_settled) return false;
        
        const payStatus = o.invoice_payment_status || (o.shipment_invoice_payment_status === "paid" ? "partially_paid" : "not_paid");
        if (payStatus === "paid") return false;
        if (payStatus !== "partially_paid") return false;

        // Cancelled after dispatch counts as a return (only dispatched orders have a paid advance).
        const isDeliveredOrReturned = ["delivered", "returned", "delivery_failed"].includes(o.status)
          || (o.status === "cancelled" && !!o.shipment_id);
        if (!isDeliveredOrReturned) return false;

        return true;
      });
    }
    return rawOrders;
  }, [rawOrders, targetInvoiceType]);

  const toggleStatus = (st: OrderStatus) => {
    setSelectedStatuses((prev) =>
      prev.includes(st) ? prev.filter((s) => s !== st) : [...prev, st]
    );
  };

  const toggleOrder = (id: string) => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllOrders = () => {
    if (selectedOrderIds.size === allOrders.length && allOrders.length > 0) {
      setSelectedOrderIds(new Set());
    } else {
      setSelectedOrderIds(new Set(allOrders.map((o) => o.id)));
    }
  };

  const selectedOrdersValueSum = useMemo(() => {
    return allOrders
      .filter((o) => selectedOrderIds.has(o.id))
      .reduce((acc, o) => acc + (o.cod_amount_expected || o.order_total || 0), 0);
  }, [allOrders, selectedOrderIds]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={
        step === "choose"
          ? "Generate Invoice"
          : step === "by_shipments"
          ? "Generate Invoice by Shipments"
          : step === "by_brand"
          ? "Generate Invoice for Brand"
          : "Generate Invoice by Orders"
      }
      width={step === "choose" ? "md" : "lg"}
    >
      {step === "choose" && (
        <div className="space-y-4 py-2">
          <p className="text-xs text-muted">
            Choose how you would like to aggregate and generate the KBB Invoice:
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* Choice 1: By Shipments */}
            <button
              type="button"
              onClick={() => {
                setTargetInvoiceType("dispatch_advance");
                setStep("by_shipments");
              }}
              className="flex flex-col justify-between rounded-lg border border-line bg-surface p-4 text-left transition-all hover:border-primary hover:bg-primary-soft/40 hover:shadow-xs group"
            >
              <div>
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-fg">
                  <Ship className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold text-ink group-hover:text-primary">
                  Generate by Shipments
                </h3>
                <p className="mt-1 text-xs text-muted leading-relaxed">
                  Select single or multiple shipments simultaneously to aggregate orders into a consolidated invoice.
                </p>
              </div>
              <div className="mt-4 flex items-center text-xs font-semibold text-primary">
                Select Shipments &rarr;
              </div>
            </button>

            {/* Choice 2: By Orders */}
            <button
              type="button"
              onClick={() => {
                setTargetInvoiceType("final_settlement");
                setStep("by_orders");
              }}
              className="flex flex-col justify-between rounded-lg border border-line bg-surface p-4 text-left transition-all hover:border-primary hover:bg-primary-soft/40 hover:shadow-xs group"
            >
              <div>
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-fg">
                  <Package className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold text-ink group-hover:text-primary">
                  Generate by Orders
                </h3>
                <p className="mt-1 text-xs text-muted leading-relaxed">
                  Select specific orders directly across brands with multi-status filtering (Delivered 50% Remaining / Returned 50% Clawback).
                </p>
              </div>
              <div className="mt-4 flex items-center text-xs font-semibold text-primary">
                Select Orders &rarr;
              </div>
            </button>

            {/* Choice 3: Brand payout */}
            <button
              type="button"
              onClick={() => setStep("by_brand")}
              className="flex flex-col justify-between rounded-lg border border-line bg-surface p-4 text-left transition-all hover:border-primary hover:bg-primary-soft/40 hover:shadow-xs group sm:col-span-2"
            >
              <div>
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-fg">
                  <HandCoins className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold text-ink group-hover:text-primary">
                  Generate Invoice for Brand
                </h3>
                <p className="mt-1 text-xs text-muted leading-relaxed">
                  Pay a brand: all delivered and returned parcels at full price, less V360 commission on delivered orders and less the returned orders. Only orders KBB has settled.
                </p>
              </div>
              <div className="mt-4 flex items-center text-xs font-semibold text-primary">
                Select Brand Orders &rarr;
              </div>
            </button>
          </div>
        </div>
      )}

      {step === "by_brand" && (
        <BrandPayoutPicker onBack={() => setStep("choose")}
          onCreated={(n) => { onBrandInvoiceCreated(n); handleClose(); }} />
      )}

      {/* STEP 2A: GENERATE BY SHIPMENTS */}
      {step === "by_shipments" && (
        <div className="space-y-4">
          {/* Invoice Type Radio Selection */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 text-xs">
            <div className="font-semibold text-ink">Invoice Type:</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTargetInvoiceType("dispatch_advance")}
                className={`flex items-center gap-1 rounded px-3 py-1 font-medium transition-colors ${
                  targetInvoiceType === "dispatch_advance"
                    ? "bg-primary text-primary-fg shadow-xs font-semibold"
                    : "bg-surface-hover text-muted hover:text-ink"
                }`}
              >
                <Truck className="h-3.5 w-3.5" /> 50% Dispatch Advance
              </button>
              <button
                type="button"
                onClick={() => setTargetInvoiceType("final_settlement")}
                className={`flex items-center gap-1 rounded px-3 py-1 font-medium transition-colors ${
                  targetInvoiceType === "final_settlement"
                    ? "bg-primary text-primary-fg shadow-xs font-semibold"
                    : "bg-surface-hover text-muted hover:text-ink"
                }`}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Final Settlement
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded border border-line bg-surface px-3 py-1.5 text-xs">
              <Search className="h-3.5 w-3.5 text-muted shrink-0" />
              <input
                type="text"
                placeholder="Search shipments by Code, Carrier, Tracking..."
                value={shipmentSearch}
                onChange={(e) => setShipmentSearch(e.target.value)}
                className="w-full bg-transparent text-ink placeholder:text-muted focus:outline-none"
              />
            </div>
            <Button size="sm" variant="ghost" onClick={() => setStep("choose")}>
              &larr; Back
            </Button>
          </div>

          {shipmentsQuery.isLoading ? (
            <div className="py-12 text-center">
              <Spinner />
            </div>
          ) : filteredShipments.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">No shipments found.</p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto rounded border border-line">
              <table className="w-full text-xs">
                <thead className="table-head sticky top-0 bg-surface border-b border-line">
                  <tr>
                    <th className="w-10 text-center">
                      <input
                        type="checkbox"
                        checked={
                          selectedShipmentIds.size > 0 &&
                          selectedShipmentIds.size === filteredShipments.length
                        }
                        onChange={toggleAllShipments}
                        className="rounded border-line text-primary focus:ring-primary"
                      />
                    </th>
                    <th>Shipment Code</th>
                    <th>Date</th>
                    <th>Carrier & Tracking</th>
                    <th className="text-center">Orders</th>
                    <th className="text-right">Est. Value (PKR)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody className="table-body divide-y divide-line">
                  {filteredShipments.map((s) => {
                    const isSelected = selectedShipmentIds.has(s.id);
                    return (
                      <tr
                        key={s.id}
                        onClick={() => toggleShipment(s.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? "bg-primary-soft/30 font-medium" : "hover:bg-surface-hover/50"
                        }`}
                      >
                        <td className="text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleShipment(s.id)}
                            className="rounded border-line text-primary focus:ring-primary"
                          />
                        </td>
                        <td className="font-semibold text-ink">{s.code}</td>
                        <td className="text-muted">{fmtDate(s.dispatched_at || s.created_at)}</td>
                        <td>
                          <div className="text-ink">{s.shipping_partner || "Carrier N/A"}</div>
                          <div className="font-mono text-[11px] text-muted">{s.tracking_number || "No tracking"}</div>
                        </td>
                        <td className="text-center">
                          {s.order_count} <span className="text-muted">({s.brand_count} b)</span>
                        </td>
                        <td className="text-right font-medium">{fmtMoney(s.cod_expected, "PKR")}</td>
                        <td>
                          <Pill {...SHIPMENT_STATUS[s.status as ShipmentStatusType]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Selection Bottom Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-xs">
            <div>
              Selected: <strong className="text-primary">{selectedShipmentIds.size} Shipment(s)</strong>
              {selectedShipmentIds.size > 0 && (
                <span className="ml-2 text-muted">
                  ({selectedShipmentsOrdersSum} Orders · Total {fmtMoney(selectedShipmentsValueSum, "PKR")})
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={handleClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={selectedShipmentIds.size === 0}
                onClick={() => {
                  onGenerateShipments(selectedShipmentsList, targetInvoiceType);
                  handleClose();
                }}
              >
                Generate Invoice ({selectedShipmentIds.size})
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2B: GENERATE BY ORDERS */}
      {step === "by_orders" && (
        <div className="space-y-4">
          {/* Invoice Type Radio Selection */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 text-xs">
            <div className="font-semibold text-ink">Invoice Type:</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTargetInvoiceType("dispatch_advance")}
                className={`flex items-center gap-1 rounded px-3 py-1 font-medium transition-colors ${
                  targetInvoiceType === "dispatch_advance"
                    ? "bg-primary text-primary-fg shadow-xs font-semibold"
                    : "bg-surface-hover text-muted hover:text-ink"
                }`}
              >
                <Truck className="h-3.5 w-3.5" /> 50% Dispatch Advance
              </button>
              <button
                type="button"
                onClick={() => setTargetInvoiceType("final_settlement")}
                className={`flex items-center gap-1 rounded px-3 py-1 font-medium transition-colors ${
                  targetInvoiceType === "final_settlement"
                    ? "bg-primary text-primary-fg shadow-xs font-semibold"
                    : "bg-surface-hover text-muted hover:text-ink"
                }`}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Final Settlement (Delivered & Returned)
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Search Box */}
            <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded border border-line bg-surface px-3 py-1.5 text-xs">
              <Search className="h-3.5 w-3.5 text-muted shrink-0" />
              <input
                type="text"
                placeholder="Search orders by Number, Customer, Brand, City..."
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                className="w-full bg-transparent text-ink placeholder:text-muted focus:outline-none"
              />
            </div>

            {/* Multi-Status Filter Dropdown Trigger (Dispatch Advance Only) */}
            {targetInvoiceType === "dispatch_advance" ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowStatusFilterMenu((prev) => !prev)}
                  className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
                    selectedStatuses.length > 0
                      ? "border-primary bg-primary-soft/50 text-primary"
                      : "border-line bg-surface text-ink hover:bg-surface-hover"
                  }`}
                >
                  <Filter className="h-3.5 w-3.5" />
                  <span>
                    Status Filter{" "}
                    {selectedStatuses.length > 0 ? `(${selectedStatuses.length} selected)` : "(All)"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>

                {/* Dropdown Menu */}
                {showStatusFilterMenu && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-line bg-surface p-3 shadow-lg">
                    <div className="mb-2 flex items-center justify-between border-b border-line pb-2">
                      <span className="text-xs font-semibold text-ink">Filter Statuses</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedStatuses([])}
                          className="text-[11px] font-medium text-muted hover:text-ink"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowStatusFilterMenu(false)}
                          className="rounded p-0.5 text-muted hover:bg-surface-hover hover:text-ink"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="max-h-60 overflow-y-auto space-y-1 text-xs">
                      {ALL_STATUS_OPTIONS.map((opt) => {
                        const isChecked = selectedStatuses.includes(opt.value);
                        return (
                          <label
                            key={opt.value}
                            className="flex cursor-pointer items-center justify-between rounded px-2 py-1 transition-colors hover:bg-surface-hover"
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleStatus(opt.value)}
                                className="rounded border-line text-primary focus:ring-primary"
                              />
                              <span className="text-ink">{opt.label}</span>
                            </div>
                            <span className="text-[10px] text-muted">{opt.group}</span>
                          </label>
                        );
                      })}
                    </div>

                    <div className="mt-2 border-t border-line pt-2 text-right">
                      <Button
                        size="sm"
                        variant="primary"
                        className="w-full"
                        onClick={() => setShowStatusFilterMenu(false)}
                      >
                        Apply Status Filter ({selectedStatuses.length === 0 ? "All" : selectedStatuses.length})
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-2.5 py-1 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                Auto-filtered: Partially Paid & Delivered/Returned
              </div>
            )}

            <Button size="sm" variant="ghost" onClick={() => setStep("choose")}>
              &larr; Back
            </Button>
          </div>

          {/* Active Status Badges (Dispatch Advance) */}
          {targetInvoiceType === "dispatch_advance" && selectedStatuses.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs bg-surface-hover/30 p-2 rounded border border-line">
              <span className="text-muted text-[11px] font-medium mr-1">Filtered by:</span>
              {selectedStatuses.map((st) => (
                <span
                  key={st}
                  className="inline-flex items-center gap-1 rounded bg-primary-soft/60 px-2 py-0.5 text-[11px] font-medium text-primary"
                >
                  {STATUS[st]?.label || st}
                  <button
                    type="button"
                    onClick={() => toggleStatus(st)}
                    className="hover:text-ink"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setSelectedStatuses([])}
                className="ml-auto text-[11px] font-medium text-muted hover:text-ink underline"
              >
                Clear all filters
              </button>
            </div>
          )}

          {ordersQuery.isLoading ? (
            <div className="py-12 text-center">
              <Spinner />
            </div>
          ) : allOrders.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">No orders matching the selected status filters.</p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto rounded border border-line">
              <table className="w-full text-xs">
                <thead className="table-head sticky top-0 bg-surface border-b border-line">
                  <tr>
                    <th className="w-10 text-center">
                      <input
                        type="checkbox"
                        checked={
                          selectedOrderIds.size > 0 && selectedOrderIds.size === allOrders.length
                        }
                        onChange={toggleAllOrders}
                        className="rounded border-line text-primary focus:ring-primary"
                      />
                    </th>
                    <th>Order #</th>
                    <th>Brand</th>
                    <th>Customer</th>
                    <th>Date</th>
                    <th className="text-right">COD / Value (PKR)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody className="table-body divide-y divide-line">
                  {allOrders.map((o) => {
                    const isSelected = selectedOrderIds.has(o.id);
                    const val = o.cod_amount_expected || o.order_total || 0;
                    return (
                      <tr
                        key={o.id}
                        onClick={() => toggleOrder(o.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? "bg-primary-soft/30 font-medium" : "hover:bg-surface-hover/50"
                        }`}
                      >
                        <td className="text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOrder(o.id)}
                            className="rounded border-line text-primary focus:ring-primary"
                          />
                        </td>
                        <td className="font-semibold text-ink">{o.order_number}</td>
                        <td className="text-ink">{o.brand_name}</td>
                        <td className="text-muted">
                          {o.customer_name || "—"} ({o.city || "N/A"})
                        </td>
                        <td className="text-muted">{fmtDate(o.order_date)}</td>
                        <td className="text-right font-medium">{fmtMoney(val, "PKR")}</td>
                        <td>
                          <span className="inline-flex rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-ink">
                            {STATUS[o.status as OrderStatus]?.label || o.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Selection Bottom Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-xs">
            <div>
              Selected: <strong className="text-primary">{selectedOrderIds.size} Order(s)</strong>
              {selectedOrderIds.size > 0 && (
                <span className="ml-2 text-muted">
                  (Total {fmtMoney(selectedOrdersValueSum, "PKR")})
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={handleClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={selectedOrderIds.size === 0}
                onClick={() => {
                  onGenerateOrders(Array.from(selectedOrderIds), targetInvoiceType);
                  handleClose();
                }}
              >
                Generate Invoice ({selectedOrderIds.size})
              </Button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
