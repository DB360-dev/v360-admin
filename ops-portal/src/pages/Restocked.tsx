import { Link } from "react-router-dom";
import { PackageCheck } from "lucide-react";
import { useRestockedItems } from "@/hooks/useData";
import { fmtMoney, fmtShort } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

export function Restocked() {
  const q = useRestockedItems();
  const rows = q.data ?? [];

  return (
    <>
      <PageHeader
        title="Restocked in BD"
        description="Orders that were returned and restocked in the Bangladesh warehouse, with their line items."
      />

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[13.5px]">
            <thead className="table-head">
              <tr>
                <th>Item</th>
                <th>Order</th>
                <th>Customer</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Line total</th>
                <th>Returned</th>
                <th>Restocked</th>
                <th>Shipment</th>
                <th>Note</th>
              </tr>
            </thead>
            {q.isLoading ? <SkeletonRows cols={9} /> : (
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
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} title="Restocked items didn't load" />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <EmptyState icon={<PackageCheck className="h-6 w-6" />} title="No restocked items yet" />
        )}
      </div>
    </>
  );
}