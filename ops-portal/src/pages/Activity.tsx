import { Link } from "react-router-dom";
import { useRecentActivity } from "@/hooks/useData";
import { STATUS } from "@/lib/status";
import { fmtDateTime } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

/** Everything V360, KBB, brands and Shopify did, newest first. */
export function Activity() {
  const q = useRecentActivity(150);
  return (
    <>
      <PageHeader title="Activity" description="The latest 150 actions across all orders, by V360, KBB, brands and Shopify." />
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead className="table-head"><tr><th>When</th><th>Who</th><th>Order</th><th>What happened</th><th>Note</th></tr></thead>
            {q.isLoading ? <SkeletonRows cols={5} /> : (
              <tbody className="table-body">
                {q.data!.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-muted">{fmtDateTime(e.created_at)}</td>
                    <td className="font-medium">{e.actor_label ?? "System"}</td>
                    <td><Link to={`/orders/${e.order_id}`} className="font-semibold hover:underline">{e.order?.order_number}</Link></td>
                    <td>{e.action === "Status changed" && e.to_status ? `Moved to ${STATUS[e.to_status].label}` : e.action}</td>
                    <td className="max-w-[320px] truncate text-muted" title={e.note ?? undefined}>{e.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && q.data!.length === 0 && <EmptyState title="No activity yet" />}
      </div>
    </>
  );
}
