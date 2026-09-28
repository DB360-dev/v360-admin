import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileText, Printer, RefreshCw, Truck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useMoneySettings, useSaveInvoice } from "@/hooks/useData";
import { fmtDate } from "@/lib/format";
import { SHIPMENT_STATUS, STATUS } from "@/lib/status";
import type { Order, OrderItem, OrderStatus, ShipmentOverview } from "@/lib/types";
import { bdQty } from "@/lib/items";
import { MONEY_COLUMNS, ZERO, addAmt, orderMoney, scaleAmt, subAmt, sumAmt, type Amt, type OrderMoneyColumns } from "@/lib/money";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/States";

export type InvoiceType = "dispatch_advance" | "final_settlement";

interface KbbInvoiceDialogProps {
  open: boolean;
  onClose: () => void;
  shipment?: ShipmentOverview | null;
  shipments?: ShipmentOverview[];
  orderIds?: string[];
  initialMode?: "summary" | "detail";
  initialInvoiceType?: InvoiceType;
  /** Viewing an already-saved invoice: show it under this number and don't save it again. */
  savedInvoiceNumber?: string;
}

/** Short stable id for a set of ids, so every distinct selection gets its own invoice number. */
function selectionKey(ids: string[]): string {
  let h = 0x811c9dc5;
  for (const ch of [...ids].sort().join(",")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).toUpperCase().padStart(7, "0");
}

function fmtNum(val: number): string {
  return Math.round(val).toLocaleString("en-US");
}

/** An amount in PKR with its BDT value underneath. */
function AmtCell({ v, neg }: { v: Amt; neg?: boolean }) {
  const sign = neg ? "\u2212" : "";
  return (
    <>
      <span className="block">{sign}{fmtNum(v.pkr)} <span className="text-[10px] font-normal text-slate-500">PKR</span></span>
      <span className="block text-[10.5px] font-normal text-slate-500">{sign}{fmtNum(v.bdt)} BDT</span>
    </>
  );
}

export function KbbInvoiceDialog({
  open,
  onClose,
  shipment,
  shipments,
  orderIds,
  initialMode = "detail",
  initialInvoiceType = "dispatch_advance",
  savedInvoiceNumber,
}: KbbInvoiceDialogProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"summary" | "detail">(initialMode);
  const [invoiceType, setInvoiceType] = useState<InvoiceType>(initialInvoiceType);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setInvoiceType(initialInvoiceType);
    }
  }, [open, initialMode, initialInvoiceType]);

  const moneySettings = useMoneySettings();

  // Consolidate target shipments array
  const targetShipments = useMemo(() => {
    if (shipments && shipments.length > 0) return shipments;
    if (shipment) return [shipment];
    return [];
  }, [shipment, shipments]);

  const shipmentIds = useMemo(() => targetShipments.map((s) => s.id), [targetShipments]);

  // Fetch full orders with order_items for selected shipments or orderIds
  const shipmentFullOrdersQuery = useQuery({
    queryKey: ["invoice-full-orders", shipmentIds, orderIds],
    enabled: open && (shipmentIds.length > 0 || (!!orderIds && orderIds.length > 0)),
    queryFn: async () => {
      let q = supabase
        .from("orders")
        .select(`*, ${MONEY_COLUMNS}, brand:organizations(name), order_items(*)`);

      if (shipmentIds.length > 0) {
        q = q.in("shipment_id", shipmentIds);
      } else if (orderIds && orderIds.length > 0) {
        q = q.in("id", orderIds);
      } else {
        return [];
      }

      const { data, error } = await q.order("order_number");
      if (error) throw error;
      return (data ?? []) as unknown as (Order & OrderMoneyColumns & { brand: { name: string } | null; order_items: OrderItem[] })[];
    },
  });

  // Fetch per-brand money settings for custom KBB commission rates
  const brandSettingsQuery = useQuery({
    queryKey: ["brand-money-settings-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("brand_money_settings").select("brand_id, kbb_commission_pct");
      if (error) return {} as Record<string, number>;
      const map: Record<string, number> = {};
      for (const row of data ?? []) {
        map[row.brand_id] = Number(row.kbb_commission_pct);
      }
      return map;
    },
  });

  // Group full orders by brand for Page 2
  const fullOrdersByBrand = useMemo(() => {
    const map = new Map<string, {
      brandId: string;
      brandName: string;
      orders: (Order & OrderMoneyColumns & { brand: { name: string } | null; order_items: OrderItem[] })[];
    }>();

    for (const o of shipmentFullOrdersQuery.data ?? []) {
      const bId = o.brand_id;
      const bName = o.brand?.name || "Unknown Brand";
      const existing = map.get(bId);
      if (existing) {
        existing.orders.push(o);
      } else {
        map.set(bId, {
          brandId: bId,
          brandName: bName,
          orders: [o],
        });
      }
    }
    return Array.from(map.values());
  }, [shipmentFullOrdersQuery.data]);

  const defaultKbbPct = moneySettings.data?.kbb_commission_pct ?? 8;
  const companyName = moneySettings.data?.invoice_company_name ?? "V360 Logistics Ltd.";

  // Calculate summaries based on full orders
  const fullOrdersList = shipmentFullOrdersQuery.data ?? [];

  // ===================== DISPATCH ADVANCE BREAKDOWN CALCULATIONS =====================
  // Cash amounts (advance, remaining, clawback) use each order's COD: 0 when paid
  // online, the unpaid part when partly paid. Commission uses the full order value.
  // KBB's commission on prepaid orders is paid by V360 (it lowers what KBB pays).
  // Every amount is in PKR and BDT (FX rate of the order date, as on the Money page).
  type BrandSums = { brandId: string; brandName: string; orderCount: number; prepaidCount: number; full: Amt; cod: Amt };
  const dispatchBrandSummaryMap = new Map<string, BrandSums>();
  for (const o of fullOrdersList) {
    const m = orderMoney(o);
    const bId = o.brand_id;
    const existing = dispatchBrandSummaryMap.get(bId)
      ?? { brandId: bId, brandName: o.brand?.name || "Unknown Brand", orderCount: 0, prepaidCount: 0, full: ZERO, cod: ZERO };
    existing.orderCount += 1;
    if (m.paidOnline) existing.prepaidCount += 1;
    existing.full = addAmt(existing.full, m.full);
    existing.cod = addAmt(existing.cod, m.cod);
    dispatchBrandSummaryMap.set(bId, existing);
  }

  const dispatchBreakdownRows = Array.from(dispatchBrandSummaryMap.values()).map((b) => {
    const kbbPct = brandSettingsQuery.data?.[b.brandId] ?? defaultKbbPct;
    const kbbCommission = scaleAmt(b.full, kbbPct / 100);
    const advance50 = scaleAmt(b.cod, 0.5);
    const netRemaining = subAmt(advance50, kbbCommission);
    const totalBrandPayable = addAmt(advance50, netRemaining);
    return {
      brandId: b.brandId,
      brandName: b.brandName,
      orderCount: b.orderCount,
      prepaidCount: b.prepaidCount,
      orderValue: b.full,
      codValue: b.cod,
      kbbPct,
      kbbCommission,
      advance50,
      netRemaining,
      totalBrandPayable,
    };
  });

  const totalDispatchOrderCount = dispatchBreakdownRows.reduce((acc, r) => acc + r.orderCount, 0);
  const totalDispatchPrepaidCount = dispatchBreakdownRows.reduce((acc, r) => acc + r.prepaidCount, 0);
  const totalDispatchValue = sumAmt(dispatchBreakdownRows.map((r) => r.orderValue));
  const totalDispatchCod = sumAmt(dispatchBreakdownRows.map((r) => r.codValue));
  const totalDispatchKbbCommission = sumAmt(dispatchBreakdownRows.map((r) => r.kbbCommission));
  const totalDispatchAdvance50 = sumAmt(dispatchBreakdownRows.map((r) => r.advance50));
  const totalDispatchNetRemaining = sumAmt(dispatchBreakdownRows.map((r) => r.netRemaining));
  const totalDispatchOverallPayable = sumAmt(dispatchBreakdownRows.map((r) => r.totalBrandPayable));


  // ===================== FINAL SETTLEMENT BREAKDOWN CALCULATIONS =====================
  // Categorize orders: Delivered vs Returned / Failed
  const isOrderReturned = (st: string) =>
    ["returned", "delivery_failed", "hub_issue", "cancelled"].includes(st);

  type SettleSums = {
    brandId: string; brandName: string;
    deliveredCount: number; deliveredValue: Amt; deliveredCod: Amt;
    returnedCount: number; returnedValue: Amt; returnedCod: Amt;
  };
  const settlementBrandMap = new Map<string, SettleSums>();

  for (const o of fullOrdersList) {
    const m = orderMoney(o);
    const bId = o.brand_id;
    const existing = settlementBrandMap.get(bId) ?? {
      brandId: bId, brandName: o.brand?.name || "Unknown Brand",
      deliveredCount: 0, deliveredValue: ZERO, deliveredCod: ZERO,
      returnedCount: 0, returnedValue: ZERO, returnedCod: ZERO,
    };
    if (isOrderReturned(o.status)) {
      existing.returnedCount += 1;
      existing.returnedValue = addAmt(existing.returnedValue, m.full);
      existing.returnedCod = addAmt(existing.returnedCod, m.cod);
    } else {
      // Treat as delivered / settled
      existing.deliveredCount += 1;
      existing.deliveredValue = addAmt(existing.deliveredValue, m.full);
      existing.deliveredCod = addAmt(existing.deliveredCod, m.cod);
    }
    settlementBrandMap.set(bId, existing);
  }

  const settlementBreakdownRows = Array.from(settlementBrandMap.values()).map((b) => {
    const kbbPct = brandSettingsQuery.data?.[b.brandId] ?? defaultKbbPct;
    // Delivered: 50% of the COD cash remaining; commission on the full value
    const delivered50Remaining = scaleAmt(b.deliveredCod, 0.5);
    const kbbCommission = scaleAmt(b.deliveredValue, kbbPct / 100);
    // Returned orders: the 50% advance KBB paid on their COD is clawed back
    const returned50Clawback = scaleAmt(b.returnedCod, 0.5);
    // Net Settlement Payable = (Delivered 50% Remaining) - KBB Commission - Returned 50% Advance
    const netSettlementPayable = subAmt(subAmt(delivered50Remaining, kbbCommission), returned50Clawback);
    return {
      brandId: b.brandId,
      brandName: b.brandName,
      deliveredCount: b.deliveredCount,
      deliveredValue: b.deliveredValue,
      deliveredCod: b.deliveredCod,
      delivered50Remaining,
      kbbPct,
      kbbCommission,
      returnedCount: b.returnedCount,
      returnedValue: b.returnedValue,
      returned50Clawback,
      netSettlementPayable,
    };
  });

  const totalSettlementDeliveredCount = settlementBreakdownRows.reduce((acc, r) => acc + r.deliveredCount, 0);
  const totalSettlementDeliveredValue = sumAmt(settlementBreakdownRows.map((r) => r.deliveredValue));
  const totalSettlementDeliveredCod = sumAmt(settlementBreakdownRows.map((r) => r.deliveredCod));
  const totalSettlementDelivered50Remaining = sumAmt(settlementBreakdownRows.map((r) => r.delivered50Remaining));
  const totalSettlementKbbCommission = sumAmt(settlementBreakdownRows.map((r) => r.kbbCommission));
  const totalSettlementReturnedCount = settlementBreakdownRows.reduce((acc, r) => acc + r.returnedCount, 0);
  const totalSettlementReturnedValue = sumAmt(settlementBreakdownRows.map((r) => r.returnedValue));
  const totalSettlementReturned50Clawback = sumAmt(settlementBreakdownRows.map((r) => r.returned50Clawback));
  const totalNetSettlementPayable = sumAmt(settlementBreakdownRows.map((r) => r.netSettlementPayable));

  // Metadata labels
  let invoiceNumber = "INV-KBB-GEN";
  let shipmentRefLabel = "Custom Selection";
  let routeLabel = "PK -> BD";
  let carrierLabel = "Logistics Carrier";
  let trackingLabel = "Multi-Tracking";
  let statusLabelText = "Invoice Generated";
  let issueDate = fmtDate(new Date().toISOString());

  const displayOrderCount = invoiceType === "dispatch_advance" ? totalDispatchOrderCount : (totalSettlementDeliveredCount + totalSettlementReturnedCount);

  if (targetShipments.length === 1) {
    const s = targetShipments[0];
    invoiceNumber = invoiceType === "dispatch_advance" ? `INV-DISP-${s.code}` : `INV-SETTLE-${s.code}`;
    shipmentRefLabel = s.code;
    routeLabel = `${s.origin} -> ${s.destination}`;
    carrierLabel = s.shipping_partner || "Carrier N/A";
    trackingLabel = s.tracking_number || "Pending";
    statusLabelText = SHIPMENT_STATUS[s.status]?.label || s.status;
    issueDate = s.dispatched_at ? fmtDate(s.dispatched_at) : fmtDate(s.created_at);
  } else if (targetShipments.length > 1) {
    const key = selectionKey(targetShipments.map((s) => s.id));
    invoiceNumber = invoiceType === "dispatch_advance" ? `INV-DISP-MULTI-${key}` : `INV-SETTLE-MULTI-${key}`;
    shipmentRefLabel = targetShipments.map((s) => s.code).join(", ");
    routeLabel = "Multi-Shipment (PK -> BD)";
    carrierLabel = "Consolidated Shipments";
    trackingLabel = `${targetShipments.length} Shipments`;
    statusLabelText = "Consolidated Invoice";
  } else if (orderIds && orderIds.length > 0) {
    const key = selectionKey(orderIds);
    invoiceNumber = invoiceType === "dispatch_advance" ? `INV-DISP-ORD-${key}` : `INV-SETTLE-ORD-${key}`;
    shipmentRefLabel = `${orderIds.length} Custom Orders`;
    routeLabel = "Direct Order Selection";
    carrierLabel = "Order Invoice";
    trackingLabel = `${displayOrderCount} Orders`;
    statusLabelText = "Order-based Invoice";
  }

  // An existing invoice keeps its own number (as long as it's the type being shown).
  const viewingSaved = !!savedInvoiceNumber && invoiceType === initialInvoiceType;
  if (viewingSaved) invoiceNumber = savedInvoiceNumber!;

  const saveInvoice = useSaveInvoice();
  const isLoading = moneySettings.isLoading || brandSettingsQuery.isLoading || shipmentFullOrdersQuery.isLoading;

  useEffect(() => {
    if (open && !isLoading && displayOrderCount > 0 && !viewingSaved) {
      const isAdv = invoiceType === "dispatch_advance";
      // Saved amounts are PKR.
      const totalVal = isAdv ? totalDispatchValue.pkr : (totalSettlementDeliveredValue.pkr + totalSettlementReturnedValue.pkr);
      const advAmt = isAdv ? totalDispatchAdvance50.pkr : 0;
      const netRem = isAdv ? totalDispatchNetRemaining.pkr : totalSettlementDelivered50Remaining.pkr;
      // What this invoice asks KBB to pay: the 50% advance, or the net settlement.
      const payable = isAdv ? totalDispatchAdvance50.pkr : totalNetSettlementPayable.pkr;
      const brandCnt = fullOrdersByBrand.length;

      saveInvoice.mutate({
        invoiceNumber,
        invoiceType,
        shipmentIds: shipmentIds.length > 0 ? shipmentIds : undefined,
        orderIds: orderIds && orderIds.length > 0 ? orderIds : undefined,
        orderCount: displayOrderCount,
        brandCount: brandCnt,
        totalValue: totalVal,
        advanceAmount: advAmt,
        netRemaining: netRem,
        payableAmount: payable,
      });
    }
  }, [open, isLoading, invoiceNumber, invoiceType, viewingSaved]);

  const handlePrint = () => {
    window.print();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        invoiceType === "dispatch_advance"
          ? "50% Dispatch Advance Invoice"
          : "Final Settlement Invoice (Delivered & Returned)"
      }
      width="lg"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          {/* Invoice Type & View Mode Toggles */}
          <div className="flex flex-wrap items-center gap-2 no-print">
            {/* Invoice Type Toggle */}
            <div className="flex items-center gap-1 rounded-lg border border-line bg-sunken p-1 text-xs">
              <button
                type="button"
                onClick={() => setInvoiceType("dispatch_advance")}
                className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                  invoiceType === "dispatch_advance"
                    ? "bg-primary text-primary-fg shadow-xs font-semibold"
                    : "text-muted hover:text-ink"
                }`}
              >
                <Truck className="h-3.5 w-3.5" /> 50% Dispatch Advance
              </button>
              <button
                type="button"
                onClick={() => setInvoiceType("final_settlement")}
                className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                  invoiceType === "final_settlement"
                    ? "bg-primary text-primary-fg shadow-xs font-semibold"
                    : "text-muted hover:text-ink"
                }`}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Final Settlement
              </button>
            </div>

            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 rounded-lg border border-line bg-sunken p-1 text-xs">
              <button
                type="button"
                onClick={() => setMode("summary")}
                className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                  mode === "summary" ? "bg-surface text-ink shadow-xs font-semibold" : "text-muted hover:text-ink"
                }`}
              >
                <Eye className="h-3.5 w-3.5" /> Summary
              </button>
              <button
                type="button"
                onClick={() => setMode("detail")}
                className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                  mode === "detail" ? "bg-surface text-ink shadow-xs font-semibold" : "text-muted hover:text-ink"
                }`}
              >
                <FileText className="h-3.5 w-3.5" /> Detailed PDF
              </button>
            </div>
          </div>

          <div className="flex gap-2 ml-auto">
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={handlePrint} className="no-print">
              <Printer className="mr-1.5 h-4 w-4" /> Save as PDF / Print
            </Button>
          </div>
        </div>
      }
    >
      {isLoading ? (
        <div className="py-12 text-center">
          <Spinner />
          <p className="mt-2 text-xs text-muted">Calculating invoice & order itemization...</p>
        </div>
      ) : (
        <div>
          <style>{`
            @media print {
              @page {
                size: A4 portrait;
                margin: 10mm 12mm;
              }
              html, body {
                background: #ffffff !important;
                color: #000000 !important;
                height: auto !important;
                overflow: visible !important;
                margin: 0 !important;
                padding: 0 !important;
              }
              body * {
                visibility: hidden !important;
              }
              dialog {
                position: static !important;
                display: block !important;
                width: 100% !important;
                max-width: none !important;
                max-height: none !important;
                margin: 0 !important;
                padding: 0 !important;
                border: none !important;
                box-shadow: none !important;
                background: transparent !important;
                overflow: visible !important;
              }
              dialog::backdrop {
                display: none !important;
              }
              #kbb-invoice-print-area, #kbb-invoice-print-area * {
                visibility: visible !important;
              }
              #kbb-invoice-print-area {
                position: absolute !important;
                left: 0 !important;
                top: 0 !important;
                width: 100% !important;
                margin: 0 !important;
                padding: 0 !important;
                border: none !important;
                box-shadow: none !important;
                background: #ffffff !important;
                color: #000000 !important;
              }
              .page-break-before {
                page-break-before: always !important;
                break-before: page !important;
              }
              .no-print {
                display: none !important;
              }
            }
          `}</style>

          <div
            id="kbb-invoice-print-area"
            ref={printRef}
            className="rounded-lg border border-slate-300 bg-white p-6 text-slate-900 shadow-sm sm:p-8 font-sans"
          >
            {/* ==================== PAGE 1: OVERALL & BRAND SUMMARIES ==================== */}
            <div>
              {/* Header */}
              <div className="flex items-start justify-between border-b border-slate-300 pb-5 mb-5">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight text-slate-900">{companyName}</h1>
                  <p className="mt-0.5 text-xs text-slate-600">Cross-Border E-Commerce & Fulfillment</p>
                  <p className="text-xs text-slate-500">Karachi, Pakistan · support@v360.com</p>
                </div>
                <div className="text-right">
                  <span className="inline-block bg-slate-100 px-3 py-1 text-xs font-bold uppercase tracking-wider text-slate-800 border border-slate-300">
                    {invoiceType === "dispatch_advance" ? "DISPATCH ADVANCE INVOICE" : "FINAL SETTLEMENT INVOICE"}
                  </span>
                  <p className="mt-2 text-xs text-slate-600">
                    Invoice #: <strong className="text-slate-900">{invoiceNumber}</strong>
                  </p>
                  <p className="text-xs text-slate-600">
                    Date: <strong className="text-slate-900">{issueDate}</strong>
                  </p>
                </div>
              </div>

              {/* Meta details */}
              <div className="mb-6 grid grid-cols-2 gap-3 rounded bg-slate-50 p-3.5 text-xs sm:grid-cols-4 border border-slate-300">
                <div>
                  <span className="block font-bold uppercase text-slate-500 text-[10px]">Bill To</span>
                  <p className="mt-0.5 font-bold text-slate-900">KBB Fulfillment Partner</p>
                  <p className="text-slate-600">Dhaka, Bangladesh</p>
                </div>
                <div>
                  <span className="block font-bold uppercase text-slate-500 text-[10px]">Shipment Ref</span>
                  <p className="mt-0.5 font-bold text-slate-900 truncate" title={shipmentRefLabel}>{shipmentRefLabel}</p>
                  <p className="text-slate-600">{displayOrderCount} Orders</p>
                </div>
                <div>
                  <span className="block font-bold uppercase text-slate-500 text-[10px]">Route</span>
                  <p className="mt-0.5 font-bold text-slate-900">{routeLabel}</p>
                  <p className="text-slate-600">{carrierLabel}</p>
                </div>
                <div>
                  <span className="block font-bold uppercase text-slate-500 text-[10px]">Tracking</span>
                  <p className="mt-0.5 font-bold text-slate-900 truncate" title={trackingLabel}>{trackingLabel}</p>
                  <p className="text-slate-600">Status: {statusLabelText}</p>
                </div>
              </div>

              {/* ========================================================================= */}
              {/* MODE 1: DISPATCH ADVANCE INVOICE TABLES */}
              {/* ========================================================================= */}
              {invoiceType === "dispatch_advance" ? (
                <>
                  {/* TABLE 1: OVERALL SHIPMENT SUMMARY */}
                  <div className="mb-6 overflow-x-auto">
                    <table className="w-full border-collapse border border-slate-400 text-xs sm:text-sm">
                      <thead>
                        <tr>
                          <th
                            colSpan={2}
                            className="border border-slate-400 bg-slate-200 px-4 py-2 text-center font-bold tracking-wider text-slate-900 uppercase"
                          >
                            OVERALL SHIPMENT SUMMARY (50% DISPATCH ADVANCE)
                          </th>
                        </tr>
                        <tr className="bg-slate-100">
                          <th className="border border-slate-400 px-4 py-2 text-left font-bold text-slate-800">
                            Description
                          </th>
                          <th className="border border-slate-400 px-4 py-2 text-right font-bold text-slate-800 w-48">
                            Amount (PKR / BDT)
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800">Total Shipment Value</td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                            <AmtCell v={totalDispatchValue} />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800">
                            COD to Collect{totalDispatchPrepaidCount > 0 ? ` (${totalDispatchPrepaidCount} paid online: no advance or COD)` : ""}
                          </td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                            <AmtCell v={totalDispatchCod} />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800">Total KBB Commission</td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                            <AmtCell v={totalDispatchKbbCommission} />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800">50% Advance Payable on Dispatch</td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900 font-bold">
                            <AmtCell v={totalDispatchAdvance50} />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800">
                            Net Remaining Payable after COD Delivery
                          </td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                            <AmtCell v={totalDispatchNetRemaining} />
                          </td>
                        </tr>
                        <tr className="font-bold bg-slate-50">
                          <td className="border border-slate-400 px-4 py-2.5 text-slate-900 text-sm sm:text-base">
                            Total Overall Payable by KBB
                          </td>
                          <td className="border border-slate-400 px-4 py-2.5 text-right text-slate-900 text-sm sm:text-base">
                            <AmtCell v={totalDispatchOverallPayable} />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* TABLE 2: BRAND-WISE BREAKDOWN */}
                  <div className="mb-6 overflow-x-auto">
                    <table className="w-full border-collapse border border-slate-400 text-xs">
                      <thead>
                        <tr>
                          <th
                            colSpan={9}
                            className="border border-slate-400 bg-slate-200 px-4 py-2 text-center font-bold tracking-wider text-slate-900 uppercase"
                          >
                            BRAND-WISE BREAKDOWN
                          </th>
                        </tr>
                        <tr className="bg-slate-100 text-center font-bold text-slate-800">
                          <th className="border border-slate-400 px-2.5 py-2 text-left">Brand</th>
                          <th className="border border-slate-400 px-2.5 py-2 text-center">Total Orders</th>
                          <th className="border border-slate-400 px-2.5 py-2 text-right">Order Value</th>
                          <th className="border border-slate-400 px-2.5 py-2 text-right">COD to Collect</th>
                          <th className="border border-slate-400 px-2.5 py-2 text-center">KBB Commission %</th>
                          <th className="border border-slate-400 px-2.5 py-2 text-right">KBB Commission</th>
                          <th className="border border-slate-400 px-2.5 py-2 text-right">50% Advance on Dispatch</th>
                          <th className="border border-slate-400 px-2.5 py-2 text-right">
                            Net Remaining Payable after COD
                          </th>
                          <th className="border border-slate-400 px-2.5 py-2 text-right">
                            Total Overall Payable by KBB
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {dispatchBreakdownRows.map((row) => (
                          <tr key={row.brandId}>
                            <td className="border border-slate-400 px-2.5 py-2 font-medium text-slate-900">
                              {row.brandName}
                            </td>
                            <td className="border border-slate-400 px-2.5 py-2 text-center text-slate-800 font-medium">
                              {row.orderCount}
                            </td>
                            <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800">
                              <AmtCell v={row.orderValue} />
                            </td>
                            <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800">
                              <AmtCell v={row.codValue} />
                              {row.prepaidCount > 0 && <span className="block text-[10px] text-slate-500">{row.prepaidCount} paid online</span>}
                            </td>
                            <td className="border border-slate-400 px-2.5 py-2 text-center text-slate-800">
                              {row.kbbPct}%
                            </td>
                            <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800">
                              <AmtCell v={row.kbbCommission} />
                            </td>
                            <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800 font-bold">
                              <AmtCell v={row.advance50} />
                            </td>
                            <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800">
                              <AmtCell v={row.netRemaining} />
                            </td>
                            <td className="border border-slate-400 px-2.5 py-2 text-right font-bold text-slate-900">
                              <AmtCell v={row.totalBrandPayable} />
                            </td>
                          </tr>
                        ))}
                        <tr className="font-bold bg-slate-100">
                          <td className="border border-slate-400 px-2.5 py-2.5 text-slate-900">TOTAL</td>
                          <td className="border border-slate-400 px-2.5 py-2.5 text-center text-slate-900">
                            {totalDispatchOrderCount}
                          </td>
                          <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalDispatchValue} />
                          </td>
                          <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalDispatchCod} />
                          </td>
                          <td className="border border-slate-400 px-2.5 py-2.5 text-center text-slate-500">&mdash;</td>
                          <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalDispatchKbbCommission} />
                          </td>
                          <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalDispatchAdvance50} />
                          </td>
                          <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalDispatchNetRemaining} />
                          </td>
                          <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalDispatchOverallPayable} />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* Amount due on this invoice, shown on its own */}
                  <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-slate-900 bg-slate-50 px-5 py-4">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Amount due on this invoice</p>
                      <p className="text-xs text-slate-600">50% advance, payable by KBB on dispatch. The remaining amount is settled on the final settlement invoice.</p>
                    </div>
                    <p className="text-2xl font-bold text-slate-900">{fmtNum(totalDispatchAdvance50.pkr)} PKR<span className="block text-sm font-semibold text-slate-600">{fmtNum(totalDispatchAdvance50.bdt)} BDT</span></p>
                  </div>

                  {/* Payment Terms & Remittance Footnote */}
                  <div className="border-t border-slate-300 pt-4 text-xs text-slate-600">
                    <p className="font-bold text-slate-800">Dispatch Payment Terms:</p>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5 text-slate-600">
                      <li>50% Advance on Dispatch ({fmtNum(totalDispatchAdvance50.pkr)} PKR / {fmtNum(totalDispatchAdvance50.bdt)} BDT) is payable immediately upon shipment departure.</li>
                      <li>Net Remaining Payable after COD ({fmtNum(totalDispatchNetRemaining.pkr)} PKR / {fmtNum(totalDispatchNetRemaining.bdt)} BDT) is settled upon customer delivery.</li>
                      <li>Payment Reference: <strong className="text-slate-900">{invoiceNumber}</strong>.</li>
                    </ul>
                  </div>
                </>
              ) : (
                /* ========================================================================= */
                /* MODE 2: FINAL SETTLEMENT INVOICE TABLES (DELIVERED & RETURNED) */
                /* ========================================================================= */
                <>
                  {/* TABLE 1: FINAL SETTLEMENT SUMMARY */}
                  <div className="mb-6 overflow-x-auto">
                    <table className="w-full border-collapse border border-slate-400 text-xs sm:text-sm">
                      <thead>
                        <tr>
                          <th
                            colSpan={2}
                            className="border border-slate-400 bg-slate-200 px-4 py-2 text-center font-bold tracking-wider text-slate-900 uppercase"
                          >
                            FINAL SETTLEMENT SUMMARY (DELIVERED & RETURNED ORDERS)
                          </th>
                        </tr>
                        <tr className="bg-slate-100">
                          <th className="border border-slate-400 px-4 py-2 text-left font-bold text-slate-800">
                            Description
                          </th>
                          <th className="border border-slate-400 px-4 py-2 text-right font-bold text-slate-800 w-48">
                            Amount (PKR / BDT)
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800">
                            Delivered Orders Total Value ({totalSettlementDeliveredCount} Orders)
                          </td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                            <AmtCell v={totalSettlementDeliveredValue} />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800">
                            Delivered Orders COD Collected (paid-online orders: 0)
                          </td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                            <AmtCell v={totalSettlementDeliveredCod} />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800 font-medium">
                            (+) Delivered Orders 50% Remaining Payable
                          </td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-bold text-slate-900">
                            <AmtCell v={totalSettlementDelivered50Remaining} />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800 text-red-700">
                            (&minus;) Less KBB Commission on Delivered Orders
                          </td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-red-700">
                            <AmtCell v={totalSettlementKbbCommission} neg />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800">
                            Returned / Failed Orders Total Value ({totalSettlementReturnedCount} Orders)
                          </td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                            <AmtCell v={totalSettlementReturnedValue} />
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-slate-400 px-4 py-2 text-slate-800 text-red-700">
                            (&minus;) Less Returned Orders 50% Advance Previously Paid (Clawback)
                          </td>
                          <td className="border border-slate-400 px-4 py-2 text-right font-medium text-red-700">
                            <AmtCell v={totalSettlementReturned50Clawback} neg />
                          </td>
                        </tr>
                        <tr className="font-bold bg-emerald-50 text-slate-900">
                          <td className="border border-slate-400 px-4 py-2.5 text-sm sm:text-base">
                            Net Final Settlement Payable by KBB
                          </td>
                          <td className="border border-slate-400 px-4 py-2.5 text-right text-sm sm:text-base text-emerald-800">
                            <AmtCell v={totalNetSettlementPayable} />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* TABLE 2: BRAND-WISE FINAL SETTLEMENT BREAKDOWN */}
                  <div className="mb-6 overflow-x-auto">
                    <table className="w-full border-collapse border border-slate-400 text-xs">
                      <thead>
                        <tr>
                          <th
                            colSpan={9}
                            className="border border-slate-400 bg-slate-200 px-4 py-2 text-center font-bold tracking-wider text-slate-900 uppercase"
                          >
                            BRAND-WISE FINAL SETTLEMENT BREAKDOWN
                          </th>
                        </tr>
                        <tr className="bg-slate-100 text-center font-bold text-slate-800">
                          <th className="border border-slate-400 px-2 py-2 text-left">Brand</th>
                          <th className="border border-slate-400 px-2 py-2 text-center">Delivered Orders</th>
                          <th className="border border-slate-400 px-2 py-2 text-right">Delivered Value</th>
                          <th className="border border-slate-400 px-2 py-2 text-right">50% Remaining</th>
                          <th className="border border-slate-400 px-2 py-2 text-center">KBB Comm %</th>
                          <th className="border border-slate-400 px-2 py-2 text-right">KBB Comm</th>
                          <th className="border border-slate-400 px-2 py-2 text-center">Returned Orders</th>
                          <th className="border border-slate-400 px-2 py-2 text-right">Returned 50% Advance Clawback</th>
                          <th className="border border-slate-400 px-2 py-2 text-right">Net Settlement Payable</th>
                        </tr>
                      </thead>
                      <tbody>
                        {settlementBreakdownRows.map((row) => (
                          <tr key={row.brandId}>
                            <td className="border border-slate-400 px-2 py-2 font-medium text-slate-900">
                              {row.brandName}
                            </td>
                            <td className="border border-slate-400 px-2 py-2 text-center text-slate-800 font-medium">
                              {row.deliveredCount}
                            </td>
                            <td className="border border-slate-400 px-2 py-2 text-right text-slate-800">
                              <AmtCell v={row.deliveredValue} />
                            </td>
                            <td className="border border-slate-400 px-2 py-2 text-right font-medium text-slate-900">
                              <AmtCell v={row.delivered50Remaining} />
                            </td>
                            <td className="border border-slate-400 px-2 py-2 text-center text-slate-800">
                              {row.kbbPct}%
                            </td>
                            <td className="border border-slate-400 px-2 py-2 text-right text-red-700">
                              <AmtCell v={row.kbbCommission} neg />
                            </td>
                            <td className="border border-slate-400 px-2 py-2 text-center text-slate-800 font-medium">
                              {row.returnedCount}
                            </td>
                            <td className="border border-slate-400 px-2 py-2 text-right text-red-700">
                              <AmtCell v={row.returned50Clawback} neg />
                            </td>
                            <td className="border border-slate-400 px-2 py-2 text-right font-bold text-slate-900">
                              <AmtCell v={row.netSettlementPayable} />
                            </td>
                          </tr>
                        ))}
                        <tr className="font-bold bg-slate-100">
                          <td className="border border-slate-400 px-2 py-2.5 text-slate-900">TOTAL</td>
                          <td className="border border-slate-400 px-2 py-2.5 text-center text-slate-900">
                            {totalSettlementDeliveredCount}
                          </td>
                          <td className="border border-slate-400 px-2 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalSettlementDeliveredValue} />
                          </td>
                          <td className="border border-slate-400 px-2 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalSettlementDelivered50Remaining} />
                          </td>
                          <td className="border border-slate-400 px-2 py-2.5 text-center text-slate-500">&mdash;</td>
                          <td className="border border-slate-400 px-2 py-2.5 text-right text-red-700">
                            <AmtCell v={totalSettlementKbbCommission} neg />
                          </td>
                          <td className="border border-slate-400 px-2 py-2.5 text-center text-slate-900">
                            {totalSettlementReturnedCount}
                          </td>
                          <td className="border border-slate-400 px-2 py-2.5 text-right text-red-700">
                            <AmtCell v={totalSettlementReturned50Clawback} neg />
                          </td>
                          <td className="border border-slate-400 px-2 py-2.5 text-right text-slate-900">
                            <AmtCell v={totalNetSettlementPayable} />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* Amount due on this invoice, shown on its own */}
                  <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-slate-900 bg-slate-50 px-5 py-4">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Amount due on this invoice</p>
                      <p className="text-xs text-slate-600">Final settlement payable by KBB, after commission and returned-order clawbacks.</p>
                    </div>
                    <p className="text-2xl font-bold text-slate-900">{fmtNum(totalNetSettlementPayable.pkr)} PKR<span className="block text-sm font-semibold text-slate-600">{fmtNum(totalNetSettlementPayable.bdt)} BDT</span></p>
                  </div>

                  {/* Payment Terms & Remittance Footnote */}
                  <div className="border-t border-slate-300 pt-4 text-xs text-slate-600">
                    <p className="font-bold text-slate-800">Final Settlement Accounting Notes:</p>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5 text-slate-600">
                      <li>Remaining 50% ({fmtNum(totalSettlementDelivered50Remaining.pkr)} PKR / {fmtNum(totalSettlementDelivered50Remaining.bdt)} BDT) is collectible for Delivered orders.</li>
                      <li>Paid-online orders carry no advance, COD or clawback; their KBB commission is paid by V360 and deducted here.</li>
                      <li>KBB Commission ({fmtNum(totalSettlementKbbCommission.pkr)} PKR / {fmtNum(totalSettlementKbbCommission.bdt)} BDT) is deducted from Delivered order earnings.</li>
                      <li>Returned orders 50% advance previously paid at dispatch ({fmtNum(totalSettlementReturned50Clawback.pkr)} PKR / {fmtNum(totalSettlementReturned50Clawback.bdt)} BDT) is clawed back.</li>
                      <li>Net Final Amount Payable by KBB: <strong className="text-slate-900">{fmtNum(totalNetSettlementPayable.pkr)} PKR / {fmtNum(totalNetSettlementPayable.bdt)} BDT</strong>.</li>
                    </ul>
                  </div>
                </>
              )}
            </div>

            {/* ==================== PAGE 2: BRAND-BY-BRAND ITEM BREAKDOWN ==================== */}
            {(mode === "detail" || (typeof window !== "undefined" && window.matchMedia("print").matches)) && (
              <div className="page-break-before mt-12 pt-6 border-t border-slate-300">
                {/* Page 2 Header */}
                <div className="flex items-start justify-between border-b border-slate-300 pb-4 mb-6">
                  <div>
                    <h2 className="text-xl font-bold tracking-tight text-slate-900">
                      {invoiceType === "dispatch_advance" ? "Detailed View: Orders in this Shipment" : "Detailed View: Orders in this Settlement"}
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-600">
                      Each order at its full order total (items, shipping and discounts included), grouped by brand. These totals make up the Order Value on page 1.
                    </p>
                  </div>
                  <div className="text-right text-xs text-slate-600">
                    <p>Invoice Ref: <strong className="text-slate-900">{invoiceNumber}</strong></p>
                    <p className="mt-0.5 font-semibold text-slate-700">Page 2 of 2</p>
                  </div>
                </div>

                {fullOrdersByBrand.length === 0 ? (
                  <p className="text-xs text-slate-500 italic py-4">No order items found in this selection.</p>
                ) : (
                  fullOrdersByBrand.map((brandGroup) => {
                    let brandItemQtySum = 0;
                    let brandItemTotalSum: Amt = ZERO;

                    const brandRows = brandGroup.orders.flatMap((order) => {
                      const items = order.order_items || [];
                      const isReturned = isOrderReturned(order.status);
                      // One amount per order: the full order value (shipping included), in PKR and BDT.
                      const m = orderMoney(order);
                      const orderTotal = m.full;
                      const paidOnline = !m.paidOnline ? null : m.cod.pkr <= 0 ? "Paid online: no COD" : "Part paid online: COD is the unpaid part";
                      brandItemTotalSum = addAmt(brandItemTotalSum, orderTotal);
                      if (!items.length) {
                        const val = orderTotal.pkr;
                        return [{
                          orderTotal,
                          paidOnline,
                          orderRowSpan: 1,
                          orderNumber: order.order_number,
                          status: order.status,
                          isReturned,
                          productName: "Order Total (No itemized SKUs)",
                          bdUnits: 0,
                          sku: "—",
                          variant: "—",
                          unitPrice: Number(val),
                          quantity: 1,
                        }];
                      }
                      return items.map((item, idx) => {
                        const qty = item.quantity || 1;
                        const price = Number(item.unit_price || 0);
                        brandItemQtySum += qty;
                        return {
                          orderTotal,
                          paidOnline,
                          orderRowSpan: idx === 0 ? items.length : 0,
                          orderNumber: order.order_number,
                          status: order.status,
                          isReturned,
                          productName: item.product_name,
                          bdUnits: bdQty(item),
                          sku: item.sku || "—",
                          variant: item.variant || "—",
                          unitPrice: price,
                          quantity: qty,
                        };
                      });
                    });

                    return (
                      <div
                        key={brandGroup.brandId}
                        className="mb-6 rounded-lg border border-slate-300 bg-white p-4 shadow-sm"
                      >
                        {/* Brand Rounded Rectangle Top Bar */}
                        <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-3 bg-slate-100 -mx-4 -mt-4 p-4 rounded-t-lg">
                          <div>
                            <h3 className="text-base font-bold text-slate-900">{brandGroup.brandName}</h3>
                            <p className="text-xs text-slate-600">{brandGroup.orders.length} order(s)</p>
                          </div>
                          <div className="text-right">
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                              Brand total (all orders)
                            </span>
                            <p className="text-sm font-bold text-slate-900"><AmtCell v={brandItemTotalSum} /></p>
                          </div>
                        </div>

                        {/* Product Items Table */}
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse border border-slate-300 text-xs">
                            <thead>
                              <tr className="bg-slate-50 font-bold text-slate-800 text-center">
                                <th className="border border-slate-300 px-2.5 py-1.5 text-left w-24">Order #</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-center w-24">Status</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-left">Product Name</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-left w-24">SKU</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-left w-20">Variant</th>
                                                                <th className="border border-slate-300 px-2.5 py-1.5 text-center w-14">Qty</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-right w-32">Order Total incl. shipping</th>
                              </tr>
                            </thead>
                            <tbody>
                              {brandRows.map((row, idx) => (
                                <tr key={idx} className={`hover:bg-slate-50/50 ${row.isReturned ? "bg-red-50/40" : ""}`}>
                                  <td className="border border-slate-300 px-2.5 py-1.5 font-medium text-slate-900">
                                    {row.orderNumber}
                                    {row.paidOnline && row.orderRowSpan > 0 && (
                                      <div className="text-[10px] font-normal text-slate-500">{row.paidOnline}</div>
                                    )}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-center">
                                    <span
                                      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                        row.isReturned
                                          ? "bg-red-100 text-red-800"
                                          : "bg-emerald-100 text-emerald-800"
                                      }`}
                                    >
                                      {STATUS[row.status as OrderStatus]?.label || row.status}
                                    </span>
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-slate-800 font-medium">
                                    {row.productName}
                                    {row.bdUnits > 0 && (
                                      <div className="text-[10px] font-normal text-slate-500">
                                        {row.bdUnits === row.quantity ? "All" : row.bdUnits} from Bangladesh stock
                                        {row.bdUnits < row.quantity ? ` · ${row.quantity - row.bdUnits} shipped from Pakistan` : ""}
                                      </div>
                                    )}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-slate-600 font-mono text-[11px]">
                                    {row.sku}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-slate-600">
                                    {row.variant}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-center font-bold text-slate-800">
                                    {row.quantity}
                                  </td>
                                  {row.orderRowSpan > 0 && (
                                    <td rowSpan={row.orderRowSpan} className="border border-slate-300 px-2.5 py-1.5 text-right align-middle font-semibold text-slate-900">
                                      <AmtCell v={row.orderTotal} />
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="bg-slate-100 font-bold text-slate-900">
                                <td colSpan={5} className="border border-slate-300 px-2.5 py-2 text-right">
                                  {brandGroup.brandName} total:
                                </td>
                                <td className="border border-slate-300 px-2.5 py-2 text-center text-slate-900">
                                  {brandItemQtySum}
                                </td>
                                <td className="border border-slate-300 px-2.5 py-2 text-right text-slate-900">
                                  <AmtCell v={brandItemTotalSum} />
                                </td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
