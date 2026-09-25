import { useState } from "react";
import { Link } from "react-router-dom";
import { PackageX } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useBdDiscrepancies, useSetDiscrepancyResolved, type BdDiscrepancy } from "@/hooks/useData";
import { fmtShort } from "@/lib/format";
import { describeError } from "@/lib/errors";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TextArea } from "@/components/ui/Field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

type Tab = "open" | "resolved";

function ResolveDialog({ row, onClose }: { row: BdDiscrepancy | null; onClose: () => void }) {
  const m = useSetDiscrepancyResolved({ inlineErrors: true });
  const [note, setNote] = useState("");
  const close = () => { m.reset(); setNote(""); onClose(); };
  return (
    <Dialog open={!!row} onClose={close} busy={m.isPending} error={m.error ? describeError(m.error) : null}
      title={row ? `Resolve: ${row.product_name}` : ""}
      description={row ? `${row.order_number}, ${row.shipment_code ?? ""}: expected ${row.expected_qty}, received ${row.received_qty}.` : undefined}
      onSubmit={() => row && m.mutate({ id: row.id, resolved: true, note }, { onSuccess: close })}
      footer={<><Button onClick={close} disabled={m.isPending}>Cancel</Button>
        <Button type="submit" variant="primary" loading={m.isPending}>Mark resolved</Button></>}>
      <TextArea label="Note" optional rows={3} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Brand confirmed the unit is still in the Lahore warehouse" />
    </Dialog>
  );
}

export function Discrepancies() {
  const { isV360 } = useOps();
  const q = useBdDiscrepancies();
  const reopen = useSetDiscrepancyResolved();
  const [tab, setTab] = useState<Tab>("open");
  const [resolving, setResolving] = useState<BdDiscrepancy | null>(null);
  const all = q.data ?? [];
  const open = all.filter((d) => !d.resolved_at);
  const resolved = all.filter((d) => d.resolved_at);
  const rows = tab === "open" ? open : resolved;
  const cols = 10;

  return (
    <>
      <PageHeader
        title="Discrepancies"
        description="Items received in Bangladesh whose physical count didn't match the shipment manifest. Short units are still in the Pakistan warehouse."
      />

      <div role="tablist" className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-line px-1">
        {([["open", "Unresolved", open.length], ["resolved", "Resolved", resolved.length]] as const).map(([key, label, n]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] ${tab === key ? "border-primary font-medium" : "border-transparent text-muted hover:text-ink"}`}>
            {label}{n > 0 && <span className={`rounded-full px-1.5 text-[12px] ${key === "open" ? "bg-g-problem-bg font-semibold text-g-problem" : "bg-sunken text-muted"}`}>{n}</span>}
          </button>
        ))}
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-[13.5px]">
            <thead className="table-head">
              <tr>
                <th>Shipment</th>
                <th>Order</th>
                <th>Brand</th>
                <th>Item</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Received</th>
                <th className="text-right">Difference</th>
                <th>Note</th>
                <th>{tab === "open" ? "Checked" : "Resolved"}</th>
                <th className="text-right">{isV360 ? "Action" : ""}</th>
              </tr>
            </thead>
            {q.isLoading ? <SkeletonRows cols={cols} /> : (
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
                          {d.order_status === "returned" && <Pill label="Returned due to discrepancy" group="problem" />}
                        </div>
                      </td>
                      <td className="text-muted">{d.brand_name ?? "—"}</td>
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
                      <td className="max-w-[240px]">
                        {d.note ? <div className="text-muted">{d.note}</div> : <span className="text-faint">—</span>}
                        {tab === "resolved" && d.resolution_note && (
                          <div className="mt-1 text-[12.5px] text-g-done">Resolution: {d.resolution_note}</div>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-muted">
                        {tab === "open" ? fmtShort(d.checked_at) : (
                          <>
                            {fmtShort(d.resolved_at!)}
                            {d.resolved_by_name && <div className="text-[12px] text-faint">by {d.resolved_by_name}</div>}
                          </>
                        )}
                      </td>
                      <td className="text-right">
                        {isV360 && (tab === "open" ? (
                          <Button size="sm" onClick={() => setResolving(d)}>Resolve</Button>
                        ) : (
                          <Button size="sm" variant="ghost" loading={reopen.isPending && reopen.variables?.id === d.id}
                            onClick={() => reopen.mutate({ id: d.id, resolved: false })}>Un-resolve</Button>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} title="Discrepancies didn't load" />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <EmptyState icon={<PackageX className="h-6 w-6" />} title={tab === "open" ? "No unresolved discrepancies" : "No resolved discrepancies"} />
        )}
      </div>

      <ResolveDialog row={resolving} onClose={() => setResolving(null)} />
    </>
  );
}
