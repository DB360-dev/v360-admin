import { useMemo, useState } from "react";
import { Package, Search, Ship } from "lucide-react";
import { useOrderList, useShipments } from "@/hooks/useData";
import { fmtDate, fmtMoney } from "@/lib/format";
import { SHIPMENT_STATUS } from "@/lib/status";
import type { ShipmentOverview, ShipmentStatus as ShipmentStatusType } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Pill } from "@/components/ui/StatusBadge";
import { Spinner } from "@/components/ui/States";

interface GenerateInvoiceModalProps {
  open: boolean;
  onClose: () => void;
  onGenerateShipments: (shipments: ShipmentOverview[]) => void;
  onGenerateOrders: (orderIds: string[]) => void;
}

type Step = "choose" | "by_shipments" | "by_orders";

export function GenerateInvoiceModal({
  open,
  onClose,
  onGenerateShipments,
  onGenerateOrders,
}: GenerateInvoiceModalProps) {
  const [step, setStep] = useState<Step>("choose");

  // Shipment selection state
  const shipmentsQuery = useShipments("all");
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<Set<string>>(new Set());
  const [shipmentSearch, setShipmentSearch] = useState("");

  // Order selection state
  const [orderSearch, setOrderSearch] = useState("");
  const ordersQuery = useOrderList({
    statuses: null,
    search: orderSearch || undefined,
    limit: 100,
  });
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());

  // Reset state on open
  const handleClose = () => {
    setStep("choose");
    setSelectedShipmentIds(new Set());
    setSelectedOrderIds(new Set());
    setShipmentSearch("");
    setOrderSearch("");
    onClose();
  };

  const allShipments = shipmentsQuery.data ?? [];
  const filteredShipments = useMemo(() => {
    const q = shipmentSearch.trim().toLowerCase();
    if (!q) return allShipments;
    return allShipments.filter(
      (s) =>
        s.code.toLowerCase().includes(q) ||
        (s.shipping_partner && s.shipping_partner.toLowerCase().includes(q)) ||
        (s.tracking_number && s.tracking_number.toLowerCase().includes(q))
    );
  }, [allShipments, shipmentSearch]);

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
  const allOrders = ordersQuery.data?.rows ?? [];
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
          : "Generate Invoice by Orders"
      }
      width={step === "choose" ? "md" : "lg"}
    >
      {step === "choose" && (
        <div className="space-y-4 py-2">
          <p className="text-xs text-muted">
            Choose how you would like to aggregate and generate the KBB Dispatch Advance Invoice:
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* Choice 1: By Shipments */}
            <button
              type="button"
              onClick={() => setStep("by_shipments")}
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
              onClick={() => setStep("by_orders")}
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
                  Select specific orders directly across brands to generate a custom invoice calculation.
                </p>
              </div>
              <div className="mt-4 flex items-center text-xs font-semibold text-primary">
                Select Orders &rarr;
              </div>
            </button>
          </div>
        </div>
      )}

      {/* STEP 2A: GENERATE BY SHIPMENTS */}
      {step === "by_shipments" && (
        <div className="space-y-4">
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
                  onGenerateShipments(selectedShipmentsList);
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
          <div className="flex flex-wrap items-center justify-between gap-3">
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
            <Button size="sm" variant="ghost" onClick={() => setStep("choose")}>
              &larr; Back
            </Button>
          </div>

          {ordersQuery.isLoading ? (
            <div className="py-12 text-center">
              <Spinner />
            </div>
          ) : allOrders.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">No orders found.</p>
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
                        <td className="text-muted">{o.status}</td>
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
                  onGenerateOrders(Array.from(selectedOrderIds));
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
