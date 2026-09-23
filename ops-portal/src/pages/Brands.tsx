import { useState } from "react";
import { Link } from "react-router-dom";
import { Building2 } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useApproveBrand, useBrands, useRejectBrand } from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { BrandRow } from "@/lib/types";
import type { StatusGroup } from "@/lib/status";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { ActionDialog } from "@/components/ActionDialog";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

const conn = (b: BrandRow) => (Array.isArray(b.shopify_connections) ? b.shopify_connections[0] : b.shopify_connections) ?? null;
const SHOP: Record<string, { label: string; group: StatusGroup }> = {
  active: { label: "Connected", group: "done" }, pending: { label: "Not finished", group: "brand" },
  error: { label: "Error", group: "problem" }, uninstalled: { label: "Disconnected", group: "problem" },
};

export function Brands() {
  const { isAdmin } = useOps();
  const q = useBrands();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("approved");
  const approve = useApproveBrand({ inlineErrors: true });
  const reject = useRejectBrand({ inlineErrors: true });
  const [dlg, setDlg] = useState<{ kind: "approve" | "reject"; b: BrandRow } | null>(null);
  const all = q.data ?? [];
  const pending = all.filter((b) => b.approval_status === "pending").length;
  const shown = all.filter((b) => b.approval_status === tab);

  return (
    <>
      <PageHeader title="Brands" description="Brands using the portal. New registrations wait here for approval." />
      <div role="tablist" className="-mx-1 mb-4 flex gap-1 border-b border-line px-1">
        {([["approved", "Active"], ["pending", "Requests"], ["rejected", "Rejected"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] ${tab === k ? "border-primary font-medium" : "border-transparent text-muted hover:text-ink"}`}>
            {l}{k === "pending" && pending > 0 && <span className="rounded-full bg-g-brand-bg px-1.5 text-[12px] font-semibold text-g-brand">{pending}</span>}
          </button>
        ))}
      </div>
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead className="table-head"><tr><th>Brand</th><th>Contact phone</th><th>{tab === "pending" ? "Registered" : "Since"}</th><th>Shopify</th><th>Last order sync</th>{tab !== "approved" && <th>Review note</th>}<th /></tr></thead>
            {q.isLoading ? <SkeletonRows cols={6} rows={4} /> : (
              <tbody className="table-body">
                {shown.map((b) => {
                  const c = conn(b);
                  return (
                    <tr key={b.id}>
                      <td><Link to={`/orders?brand=${b.id}`} className="font-semibold hover:underline">{b.name}</Link></td>
                      <td className="text-muted">{b.contact_phone ?? "—"}</td>
                      <td className="text-muted">{fmtDate(b.created_at)}</td>
                      <td>{c ? <span className="inline-flex items-center gap-2"><Pill {...(SHOP[c.status] ?? { label: c.status, group: "closed" })} /><span className="text-[12.5px] text-faint">{c.shop_domain}</span></span> : <span className="text-faint">Not connected</span>}</td>
                      <td className="text-muted">{c?.last_synced_at ? fmtDateTime(c.last_synced_at) : "—"}</td>
                      {tab !== "approved" && <td className="max-w-[200px] truncate text-muted">{b.review_note ?? "—"}</td>}
                      <td className="whitespace-nowrap text-right">
                        {isAdmin && tab !== "approved" && <Button size="sm" variant="primary" onClick={() => { approve.reset(); setDlg({ kind: "approve", b }); }}>Approve</Button>}
                        {isAdmin && tab !== "rejected" && <Button size="sm" variant="danger-ghost" className="ml-1" onClick={() => { reject.reset(); setDlg({ kind: "reject", b }); }}>{tab === "approved" ? "Suspend" : "Reject"}</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && shown.length === 0 && (
          <EmptyState icon={<Building2 className="h-6 w-6" />} title={tab === "pending" ? "No new requests" : tab === "rejected" ? "No rejected brands" : "No active brands yet"}>
            {tab === "pending" ? "Brands that register on the brand portal appear here for approval." : undefined}
          </EmptyState>
        )}
        {!isAdmin && <p className="border-t border-line px-4 py-2 text-[12.5px] text-faint">Only V360 admins can approve or reject brands.</p>}
      </div>
      {dlg?.kind === "approve" && (
        <ActionDialog open onClose={() => setDlg(null)} busy={approve.isPending} error={approve.error ? describeError(approve.error) : null}
          title={`Approve ${dlg.b.name}?`} description="They get full access to the brand portal and can connect their Shopify store."
          confirmLabel="Approve" noteLabel="Internal note" onConfirm={(n) => approve.mutate({ id: dlg.b.id, note: n }, { onSuccess: () => setDlg(null) })} />
      )}
      {dlg?.kind === "reject" && (
        <ActionDialog open onClose={() => setDlg(null)} busy={reject.isPending} error={reject.error ? describeError(reject.error) : null}
          title={`${dlg.b.approval_status === "approved" ? "Suspend" : "Reject"} ${dlg.b.name}?`}
          description="They lose access to the brand portal immediately. The reason is shown to them." danger
          confirmLabel={dlg.b.approval_status === "approved" ? "Suspend" : "Reject"} noteLabel="Reason (shown to the brand)" noteRequired
          onConfirm={(n) => reject.mutate({ id: dlg.b.id, note: n }, { onSuccess: () => setDlg(null) })} />
      )}
    </>
  );
}
