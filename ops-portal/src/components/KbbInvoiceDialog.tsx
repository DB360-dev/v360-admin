import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileText, Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useMoneySettings } from "@/hooks/useData";
import { fmtDate } from "@/lib/format";
import { SHIPMENT_STATUS } from "@/lib/status";
import type { Order, OrderItem, ShipmentOverview } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/States";

interface KbbInvoiceDialogProps {
  open: boolean;
  onClose: () => void;
  shipment?: ShipmentOverview | null;
  shipments?: ShipmentOverview[];
  orderIds?: string[];
  initialMode?: "summary" | "detail";
}

function fmtNum(val: number): string {
  return Math.round(val).toLocaleString("en-US");
}

export function KbbInvoiceDialog({
  open,
  onClose,
  shipment,
  shipments,
  orderIds,
  initialMode = "detail",
}: KbbInvoiceDialogProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"summary" | "detail">(initialMode);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
    }
  }, [open, initialMode]);

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
        .select("*, brand:organizations(name), order_items(*)");

      if (shipmentIds.length > 0) {
        q = q.in("shipment_id", shipmentIds);
      } else if (orderIds && orderIds.length > 0) {
        q = q.in("id", orderIds);
      } else {
        return [];
      }

      const { data, error } = await q.order("order_number");
      if (error) throw error;
      return (data ?? []) as (Order & { brand: { name: string } | null; order_items: OrderItem[] })[];
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
      orders: (Order & { brand: { name: string } | null; order_items: OrderItem[] })[];
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

  // Calculate brand-wise summary rows from fetched full orders
  const fullOrdersList = shipmentFullOrdersQuery.data ?? [];

  const brandSummaryMap = new Map<string, { brandId: string; brandName: string; orderCount: number; orderValue: number }>();
  for (const o of fullOrdersList) {
    const val = o.cod_amount_expected !== null && o.cod_amount_expected !== undefined && o.cod_amount_expected > 0
      ? Number(o.cod_amount_expected)
      : Number(o.order_total || 0);

    const bId = o.brand_id;
    const bName = o.brand?.name || "Unknown Brand";

    const existing = brandSummaryMap.get(bId);
    if (existing) {
      existing.orderValue += val;
      existing.orderCount += 1;
    } else {
      brandSummaryMap.set(bId, {
        brandId: bId,
        brandName: bName,
        orderCount: 1,
        orderValue: val,
      });
    }
  }

  // Calculate brand-wise breakdown rows
  const brandBreakdownRows = Array.from(brandSummaryMap.values()).map((b) => {
    const kbbPct = brandSettingsQuery.data?.[b.brandId] ?? defaultKbbPct;
    const kbbCommission = (b.orderValue * kbbPct) / 100;
    const advance50 = 0.5 * b.orderValue;
    const netRemaining = advance50 - kbbCommission;
    const totalBrandPayable = advance50 + netRemaining;

    return {
      brandId: b.brandId,
      brandName: b.brandName,
      orderCount: b.orderCount,
      orderValue: b.orderValue,
      kbbPct,
      kbbCommission,
      advance50,
      netRemaining,
      totalBrandPayable,
    };
  });

  // Calculate Totals
  const totalOrderCount = brandBreakdownRows.reduce((acc, r) => acc + r.orderCount, 0);
  const totalShipmentValue = brandBreakdownRows.reduce((acc, r) => acc + r.orderValue, 0);
  const totalKbbCommission = brandBreakdownRows.reduce((acc, r) => acc + r.kbbCommission, 0);
  const totalAdvance50 = brandBreakdownRows.reduce((acc, r) => acc + r.advance50, 0);
  const totalNetRemaining = brandBreakdownRows.reduce((acc, r) => acc + r.netRemaining, 0);
  const totalOverallPayable = brandBreakdownRows.reduce((acc, r) => acc + r.totalBrandPayable, 0);

  // Metadata labels
  let invoiceNumber = "INV-KBB-GEN";
  let shipmentRefLabel = "Custom Selection";
  let routeLabel = "PK -> BD";
  let carrierLabel = "Logistics Carrier";
  let trackingLabel = "Multi-Tracking";
  let statusLabelText = "Invoice Generated";
  let issueDate = fmtDate(new Date().toISOString());

  if (targetShipments.length === 1) {
    const s = targetShipments[0];
    invoiceNumber = `INV-KBB-${s.code}`;
    shipmentRefLabel = s.code;
    routeLabel = `${s.origin} -> ${s.destination}`;
    carrierLabel = s.shipping_partner || "Carrier N/A";
    trackingLabel = s.tracking_number || "Pending";
    statusLabelText = SHIPMENT_STATUS[s.status]?.label || s.status;
    issueDate = s.dispatched_at ? fmtDate(s.dispatched_at) : fmtDate(s.created_at);
  } else if (targetShipments.length > 1) {
    invoiceNumber = `INV-KBB-MULTI-${targetShipments.length}`;
    shipmentRefLabel = targetShipments.map((s) => s.code).join(", ");
    routeLabel = "Multi-Shipment (PK -> BD)";
    carrierLabel = "Consolidated Shipments";
    trackingLabel = `${targetShipments.length} Shipments`;
    statusLabelText = "Consolidated Invoice";
  } else if (orderIds && orderIds.length > 0) {
    invoiceNumber = `INV-KBB-ORD-${orderIds.length}`;
    shipmentRefLabel = `${orderIds.length} Custom Orders`;
    routeLabel = "Direct Order Selection";
    carrierLabel = "Order Invoice";
    trackingLabel = `${totalOrderCount} Orders`;
    statusLabelText = "Order-based Invoice";
  }

  const handlePrint = () => {
    window.print();
  };

  const isLoading = moneySettings.isLoading || brandSettingsQuery.isLoading || shipmentFullOrdersQuery.isLoading;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "summary" ? "Invoice Summary" : "Detailed Invoice (2-Page PDF)"}
      width="lg"
      footer={
        <div className="flex w-full items-center justify-between">
          <div className="flex items-center gap-1 rounded border border-line bg-sunken p-0.5 text-xs no-print">
            <button
              type="button"
              onClick={() => setMode("summary")}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                mode === "summary" ? "bg-surface text-ink shadow-xs font-semibold" : "text-muted hover:text-ink"
              }`}
            >
              <Eye className="h-3.5 w-3.5" /> Summary View
            </button>
            <button
              type="button"
              onClick={() => setMode("detail")}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                mode === "detail" ? "bg-surface text-ink shadow-xs font-semibold" : "text-muted hover:text-ink"
              }`}
            >
              <FileText className="h-3.5 w-3.5" /> Detailed View (Page 1 & 2)
            </button>
          </div>

          <div className="flex gap-2">
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
                    DISPATCH ADVANCE INVOICE
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
                  <p className="text-slate-600">{totalOrderCount} Orders</p>
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

              {/* TABLE 1: OVERALL SHIPMENT SUMMARY */}
              <div className="mb-6 overflow-x-auto">
                <table className="w-full border-collapse border border-slate-400 text-xs sm:text-sm">
                  <thead>
                    <tr>
                      <th
                        colSpan={2}
                        className="border border-slate-400 bg-slate-200 px-4 py-2 text-center font-bold tracking-wider text-slate-900 uppercase"
                      >
                        OVERALL SHIPMENT SUMMARY
                      </th>
                    </tr>
                    <tr className="bg-slate-100">
                      <th className="border border-slate-400 px-4 py-2 text-left font-bold text-slate-800">
                        Description
                      </th>
                      <th className="border border-slate-400 px-4 py-2 text-right font-bold text-slate-800 w-48">
                        Amount (PKR)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-slate-400 px-4 py-2 text-slate-800">Total Shipment Value</td>
                      <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                        {fmtNum(totalShipmentValue)}
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-slate-400 px-4 py-2 text-slate-800">Total KBB Commission</td>
                      <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                        {fmtNum(totalKbbCommission)}
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-slate-400 px-4 py-2 text-slate-800">50% Payable on Dispatch</td>
                      <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                        {fmtNum(totalAdvance50)}
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-slate-400 px-4 py-2 text-slate-800">
                        Net Remaining Payable after COD Delivery
                      </td>
                      <td className="border border-slate-400 px-4 py-2 text-right font-medium text-slate-900">
                        {fmtNum(totalNetRemaining)}
                      </td>
                    </tr>
                    <tr className="font-bold bg-slate-50">
                      <td className="border border-slate-400 px-4 py-2.5 text-slate-900 text-sm sm:text-base">
                        Total Overall Payable by KBB
                      </td>
                      <td className="border border-slate-400 px-4 py-2.5 text-right text-slate-900 text-sm sm:text-base">
                        {fmtNum(totalOverallPayable)}
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
                        colSpan={8}
                        className="border border-slate-400 bg-slate-200 px-4 py-2 text-center font-bold tracking-wider text-slate-900 uppercase"
                      >
                        BRAND-WISE BREAKDOWN
                      </th>
                    </tr>
                    <tr className="bg-slate-100 text-center font-bold text-slate-800">
                      <th className="border border-slate-400 px-2.5 py-2 text-left">Brand</th>
                      <th className="border border-slate-400 px-2.5 py-2 text-center">Total Orders</th>
                      <th className="border border-slate-400 px-2.5 py-2 text-right">Order Value (PKR)</th>
                      <th className="border border-slate-400 px-2.5 py-2 text-center">KBB Commission %</th>
                      <th className="border border-slate-400 px-2.5 py-2 text-right">KBB Commission (PKR)</th>
                      <th className="border border-slate-400 px-2.5 py-2 text-right">50% Advance on Dispatch (PKR)</th>
                      <th className="border border-slate-400 px-2.5 py-2 text-right">
                        Net Remaining Payable after COD (PKR)
                      </th>
                      <th className="border border-slate-400 px-2.5 py-2 text-right">
                        Total Overall Payable by KBB (PKR)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {brandBreakdownRows.map((row) => (
                      <tr key={row.brandId}>
                        <td className="border border-slate-400 px-2.5 py-2 font-medium text-slate-900">
                          {row.brandName}
                        </td>
                        <td className="border border-slate-400 px-2.5 py-2 text-center text-slate-800 font-medium">
                          {row.orderCount}
                        </td>
                        <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800">
                          {fmtNum(row.orderValue)}
                        </td>
                        <td className="border border-slate-400 px-2.5 py-2 text-center text-slate-800">
                          {row.kbbPct}%
                        </td>
                        <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800">
                          {fmtNum(row.kbbCommission)}
                        </td>
                        <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800">
                          {fmtNum(row.advance50)}
                        </td>
                        <td className="border border-slate-400 px-2.5 py-2 text-right text-slate-800">
                          {fmtNum(row.netRemaining)}
                        </td>
                        <td className="border border-slate-400 px-2.5 py-2 text-right font-bold text-slate-900">
                          {fmtNum(row.totalBrandPayable)}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-bold bg-slate-100">
                      <td className="border border-slate-400 px-2.5 py-2.5 text-slate-900">TOTAL</td>
                      <td className="border border-slate-400 px-2.5 py-2.5 text-center text-slate-900">
                        {totalOrderCount}
                      </td>
                      <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                        {fmtNum(totalShipmentValue)}
                      </td>
                      <td className="border border-slate-400 px-2.5 py-2.5 text-center text-slate-500">&mdash;</td>
                      <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                        {fmtNum(totalKbbCommission)}
                      </td>
                      <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                        {fmtNum(totalAdvance50)}
                      </td>
                      <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                        {fmtNum(totalNetRemaining)}
                      </td>
                      <td className="border border-slate-400 px-2.5 py-2.5 text-right text-slate-900">
                        {fmtNum(totalOverallPayable)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Payment Terms & Remittance Footnote */}
              <div className="border-t border-slate-300 pt-4 text-xs text-slate-600">
                <p className="font-bold text-slate-800">Payment Terms & Remittance Notes:</p>
                <ul className="mt-1 list-disc pl-4 space-y-0.5 text-slate-600">
                  <li>50% Advance on Dispatch ({fmtNum(totalAdvance50)} PKR) is payable immediately upon shipment departure.</li>
                  <li>Net Remaining Payable after COD ({fmtNum(totalNetRemaining)} PKR) is settled upon customer delivery.</li>
                  <li>Payment Reference: <strong className="text-slate-900">{invoiceNumber}</strong>.</li>
                </ul>
              </div>
            </div>

            {/* ==================== PAGE 2: BRAND-BY-BRAND ITEM BREAKDOWN ==================== */}
            {(mode === "detail" || (typeof window !== "undefined" && window.matchMedia("print").matches)) && (
              <div className="page-break-before mt-12 pt-6 border-t border-slate-300">
                {/* Page 2 Header */}
                <div className="flex items-start justify-between border-b border-slate-300 pb-4 mb-6">
                  <div>
                    <h2 className="text-xl font-bold tracking-tight text-slate-900">
                      Shipment Itemized Product Breakdown
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-600">
                      Detailed Product & SKU Breakdown Grouped by Brand
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
                    let brandItemTotalSum = 0;

                    const brandRows = brandGroup.orders.flatMap((order) => {
                      const items = order.order_items || [];
                      if (!items.length) {
                        const val = order.cod_amount_expected || order.order_total || 0;
                        brandItemTotalSum += Number(val);
                        return [{
                          orderNumber: order.order_number,
                          productName: "Order Total (No itemized SKUs)",
                          sku: "—",
                          variant: "—",
                          unitPrice: Number(val),
                          quantity: 1,
                          subtotal: Number(val),
                        }];
                      }
                      return items.map((item) => {
                        const qty = item.quantity || 1;
                        const price = Number(item.unit_price || 0);
                        const subtotal = qty * price - Number(item.discount || 0);
                        brandItemQtySum += qty;
                        brandItemTotalSum += subtotal;
                        return {
                          orderNumber: order.order_number,
                          productName: item.product_name,
                          sku: item.sku || "—",
                          variant: item.variant || "—",
                          unitPrice: price,
                          quantity: qty,
                          subtotal: subtotal,
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
                            <p className="text-xs text-slate-600">{brandGroup.orders.length} Order(s) in Selection</p>
                          </div>
                          <div className="text-right">
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                              Brand Total Value
                            </span>
                            <p className="text-sm font-bold text-slate-900">{fmtNum(brandItemTotalSum)} PKR</p>
                          </div>
                        </div>

                        {/* Product Items Table */}
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse border border-slate-300 text-xs">
                            <thead>
                              <tr className="bg-slate-50 font-bold text-slate-800 text-center">
                                <th className="border border-slate-300 px-2.5 py-1.5 text-left w-24">Order #</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-left">Product Name</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-left w-28">SKU</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-left w-24">Variant</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-right w-24">Price (PKR)</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-center w-16">Qty</th>
                                <th className="border border-slate-300 px-2.5 py-1.5 text-right w-28">Subtotal (PKR)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {brandRows.map((row, idx) => (
                                <tr key={idx} className="hover:bg-slate-50/50">
                                  <td className="border border-slate-300 px-2.5 py-1.5 font-medium text-slate-900">
                                    {row.orderNumber}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-slate-800 font-medium">
                                    {row.productName}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-slate-600 font-mono text-[11px]">
                                    {row.sku}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-slate-600">
                                    {row.variant}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-right text-slate-800">
                                    {fmtNum(row.unitPrice)}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-center font-bold text-slate-800">
                                    {row.quantity}
                                  </td>
                                  <td className="border border-slate-300 px-2.5 py-1.5 text-right font-semibold text-slate-900">
                                    {fmtNum(row.subtotal)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="bg-slate-100 font-bold text-slate-900">
                                <td colSpan={5} className="border border-slate-300 px-2.5 py-2 text-right">
                                  {brandGroup.brandName} Total:
                                </td>
                                <td className="border border-slate-300 px-2.5 py-2 text-center text-slate-900">
                                  {brandItemQtySum}
                                </td>
                                <td className="border border-slate-300 px-2.5 py-2 text-right text-slate-900">
                                  {fmtNum(brandItemTotalSum)}
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
