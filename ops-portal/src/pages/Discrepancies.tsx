import { Link } from "react-router-dom";
import { PackageX } from "lucide-react";
import { useBdDiscrepancies } from "@/hooks/useData";
import { fmtShort } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

export function Discrepancies() {
  const q = useBdDiscrepancies();
  const rows = q.data ?? [];

  return (
    <>
      <PageHeader
        title="Discrepancies"
        description="Items received in Bangladesh whose physical count didn't match the shipment manifest."
      />

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-[13.5px]">
            <thead className="table-head">
              <tr>
                <th>Shipment</th>
                <th>Order</th>
                <th>Item</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Received</th>
                <th className="text-right">Difference</th>
                <th>Note</th>
                <th>Checked</th>
              </tr>
            </thead>
            {q.isLoading ? <SkeletonRows cols={8} /> : (
              <tbody className="table-body">
                {rows.map((d) => {
                  const diff = d.difference;
                  const short = diff < 0;
                  return (
                    <tr key={d.id}>
                      <td>
                        <Link to={`/shipments/${d.shipment_id}`} className="font-semibold hover:underline">
                          {d.shipment_code}
                        </Link>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <Link to={`/orders/${d.order_id}`} className="hover:underline">
                            {d.order_number}
                          </Link>
                          {d.order_status === "hold" && <Pill label="Held" group="problem" />}
                        </div>
                      </td>
                      <td>
                        <span>{d.product_name}</span>
                        {d.variant && <span className="text-faint"> · {d.variant}</span>}
                        {d.sku && <div className="text-[12px] text-faint">{d.sku}</div>}
                      </td>
                      <td className="text-right">{d.expected_qty}</td>
                      <td className="text-right">{d.received_qty}</td>
                      <td className={`text-right font-semibold ${short ? "text-g-problem" : "text-primary"}`}>
                        {diff > 0 ? `+${diff}` : diff}
                      </td>
                      <td className="max-w-[220px]">
                        {d.note
                          ? <span className="text-muted">{d.note}</span>
                          : <span className="text-faint">—</span>}
                      </td>
                      <td className="whitespace-nowrap text-muted">{fmtShort(d.checked_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} title="Discrepancies didn't load" />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <EmptyState icon={<PackageX className="h-6 w-6" />} title="No discrepancies" />
        )}
      </div>
    </>
  );
}
