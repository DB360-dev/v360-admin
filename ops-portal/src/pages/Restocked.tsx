import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, PackageCheck, Truck } from "lucide-react";
import { useDispatchedItems, useInventoryOrders, useRestockedItems } from "@/hooks/useData";
import { fmtMoney, fmtShort } from "@/lib/format";
import { STATUS } from "@/lib/status";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

function DispatchedTable() {
  const q = useDispatchedItems();
  const rows = q.data ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-[13.5px]">
        <thead className="table-head">
          <tr>
            <th>Item</th>
            <th>Order</th>
            <th>Customer</th>
            <th>Status</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Line total</th>
            <th>Dispatched</th>
            <th>Shipment</th>
          </tr>
        </thead>
        {q.isLoading ? <SkeletonRows cols={8} /> : (
          <tbody className="table-body">
            {rows.map((r) => (
              <tr key={r.order_item_id}>
                <td>
                  <span>{r.product_name}</span>
                  {r.variant && <span className="text-faint"> · {r.variant}</span>}
                  {r.sku && <div className="text-[12px] text-faint">{r.sku}</div>}
                </td>
                <td>
                  <Link to={`/orders/${r.order_id}`} className="hover:underline">
                    {r.order_number}
                  </Link>
                  <div className="text-[12px] text-faint">{r.brand_name}</div>
                </td>
                <td>
                  <span>{r.customer_name ?? "—"}</span>
                  {r.city && <div className="text-[12px] text-faint">{r.city}</div>}
                </td>
                <td>
                  {STATUS[r.status as keyof typeof STATUS]
                    ? <Pill group={STATUS[r.status as keyof typeof STATUS].group} label={STATUS[r.status as keyof typeof STATUS].label} />
                    : <span className="text-faint">{r.status}</span>}
                </td>
                <td className="text-right">{r.quantity}</td>
                <td className="text-right whitespace-nowrap">{fmtMoney(r.line_total, r.currency)}</td>
                <td className="whitespace-nowrap text-muted">{fmtShort(r.dispatched_at)}</td>
                <td>
                  {r.shipment_code
                    ? <Link to={`/shipments/${r.shipment_id}`} className="hover:underline">{r.shipment_code}</Link>
                    : <span className="text-faint">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function StockTable() {
  const q = useRestockedItems();
  const rows = q.data ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-[13.5px]">
        <thead className="table-head">
          <tr>
            <th>Item</th>
            <th>Order</th>
            <th>Customer</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Available</th>
            <th className="text-right">Line total</th>
            <th>Returned</th>
            <th>Restocked</th>
            <th>Shipment</th>
            <th>Note</th>
          </tr>
        </thead>
        {q.isLoading ? <SkeletonRows cols={10} /> : (
          <tbody className="table-body">
            {rows.map((r) => (
              <tr key={r.order_item_id}>
                <td>
                  <span>{r.product_name}</span>
                  {r.variant && <span className="text-faint"> · {r.variant}</span>}
                  {r.sku && <div className="text-[12px] text-faint">{r.sku}</div>}
                </td>
                <td>
                  <Link to={`/orders/${r.order_id}`} className="hover:underline">
                    {r.order_number}
                  </Link>
                  <div className="text-[12px] text-faint">{r.brand_name}</div>
                </td>
                <td>
                  <span>{r.customer_name ?? "—"}</span>
                  {r.city && <div className="text-[12px] text-faint">{r.city}</div>}
                </td>
                <td className="text-right">{r.quantity}</td>
                <td className="text-right tabular-nums">
                  <span className={(r.available_qty ?? r.quantity) > 0 ? "font-medium" : "text-faint"}>
                    {r.available_qty ?? r.quantity}
                  </span>
                </td>
                <td className="text-right whitespace-nowrap">{fmtMoney(r.line_total, r.currency)}</td>
                <td className="whitespace-nowrap text-muted">{fmtShort(r.returned_at)}</td>
                <td className="whitespace-nowrap text-muted">
                  {r.restocked_at ? fmtShort(r.restocked_at) : <span className="text-faint">—</span>}
                </td>
                <td>
                  {r.shipment_code
                    ? <Link to={`/shipments/${r.shipment_id}`} className="hover:underline">{r.shipment_code}</Link>
                    : <span className="text-faint">—</span>}
                </td>
                <td className="max-w-[200px]">
                  {r.restock_note
                    ? <span className="text-muted">{r.restock_note}</span>
                    : <span className="text-faint">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function LocalStockOrdersTable() {
  const q = useInventoryOrders();
  const rows = q.data ?? [];

  const byOrder = useMemo(() => {
    const map = new Map<string, {
      order_number: string; order_date: string; brand_name: string;
      customer_name: string | null; city: string | null; status: string;
      items: typeof rows;
    }>();
    for (const r of rows) {
      if (!map.has(r.order_id)) {
        map.set(r.order_id, {
          order_number: r.order_number,
          order_date: r.order_date,
          brand_name: r.brand_name,
          customer_name: r.customer_name,
          city: r.city,
          status: r.status,
          items: [],
        });
      }
      map.get(r.order_id)!.items.push(r);
    }
    return [...map.entries()];
  }, [rows]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-[13.5px]">
        <thead className="table-head">
          <tr>
            <th>Order</th>
            <th>Brand</th>
            <th>Customer</th>
            <th>Item</th>
            <th>Status</th>
            <th className="text-right">From inventory</th>
            <th className="text-right">Total ordered</th>
          </tr>
        </thead>
        {q.isLoading ? <SkeletonRows cols={7} /> : (
          <tbody className="table-body">
            {byOrder.map(([orderId, o]) =>
              o.items.map((item, idx) => (
                <tr key={item.order_item_id}>
                  {idx === 0 && (
                    <td rowSpan={o.items.length} className="align-top">
                      <Link to={`/orders/${orderId}`} className="hover:underline font-medium">
                        {o.order_number}
                      </Link>
                      <div className="text-[12px] text-faint">{fmtShort(o.order_date)}</div>
                    </td>
                  )}
                  {idx === 0 && (
                    <td rowSpan={o.items.length} className="align-top text-muted">
                      {o.brand_name}
                    </td>
                  )}
                  {idx === 0 && (
                    <td rowSpan={o.items.length} className="align-top">
                      <span>{o.customer_name ?? "—"}</span>
                      {o.city && <div className="text-[12px] text-faint">{o.city}</div>}
                    </td>
                  )}
                  <td>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full bg-orange-500" aria-hidden />
                      <span className="font-medium">{item.product_name}</span>
                    </span>
                    {item.variant && <span className="text-faint text-[12px]"> · {item.variant}</span>}
                    {item.sku && <div className="text-[12px] text-faint">{item.sku}</div>}
                  </td>
                  {idx === 0 && (
                    <td rowSpan={o.items.length} className="align-top">
                      {STATUS[o.status as keyof typeof STATUS]
                        ? <Pill group={STATUS[o.status as keyof typeof STATUS].group} label={STATUS[o.status as keyof typeof STATUS].label} />
                        : <span className="text-faint">{o.status}</span>}
                    </td>
                  )}
                  <td className="text-right tabular-nums font-medium text-orange-600">{item.inventory_qty}</td>
                  <td className="text-right tabular-nums text-muted">{item.quantity}</td>
                </tr>
              ))
            )}
          </tbody>
        )}
      </table>
    </div>
  );
}

export function Restocked() {
  const [tab, setTab] = useState<"orders" | "stock" | "local">("orders");
  const stock = useRestockedItems();
  const dispatched = useDispatchedItems();
  const localOrders = useInventoryOrders();

  const tabs = [
    { key: "orders" as const, label: "Order", icon: Truck, count: dispatched.data?.length },
    { key: "stock" as const, label: "Stock", icon: PackageCheck, count: stock.data?.length },
    { key: "local" as const, label: "Local stock orders", icon: Archive, count: localOrders.data ? [...new Set(localOrders.data.map(r => r.order_id))].length : undefined },
  ];

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Dispatched orders from the Bangladesh warehouse, returned items restocked into inventory, and orders fulfilled from local brand stock."
      />

      <div role="tablist" className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-line px-1">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] ${tab === t.key ? "border-primary font-medium" : "border-transparent text-muted hover:text-ink"}`}>
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
            {t.count !== undefined && (
              <span className="rounded-full bg-sunken px-1.5 text-[12px] font-semibold text-ink">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="panel overflow-hidden">
        {tab === "stock" && (
          <>
            <StockTable />
            {stock.isError && <ErrorState error={stock.error} onRetry={() => stock.refetch()} title="Stock didn't load" />}
            {!stock.isLoading && !stock.isError && stock.data?.length === 0 && (
              <EmptyState icon={<PackageCheck className="h-6 w-6" />} title="No restocked items" />
            )}
          </>
        )}
        {tab === "orders" && (
          <>
            <DispatchedTable />
            {dispatched.isError && <ErrorState error={dispatched.error} onRetry={() => dispatched.refetch()} title="Orders didn't load" />}
            {!dispatched.isLoading && !dispatched.isError && dispatched.data?.length === 0 && (
              <EmptyState icon={<Truck className="h-6 w-6" />} title="No dispatched orders" />
            )}
          </>
        )}
        {tab === "local" && (
          <>
            <LocalStockOrdersTable />
            {localOrders.isError && <ErrorState error={localOrders.error} onRetry={() => localOrders.refetch()} title="Local stock orders didn't load" />}
            {!localOrders.isLoading && !localOrders.isError && localOrders.data?.length === 0 && (
              <EmptyState icon={<Archive className="h-6 w-6" />} title="No orders from local stock yet" />
            )}
          </>
        )}
      </div>
    </>
  );
}
