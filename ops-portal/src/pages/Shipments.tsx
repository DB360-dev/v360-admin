import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Ship } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useCreateShipment, useShipments, useStatusCounts } from "@/hooks/useData";
import { SHIPMENT_STATUS } from "@/lib/status";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { describeError } from "@/lib/errors";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { ActionDialog } from "@/components/ActionDialog";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

export function Shipments() {
  const { isV360 } = useOps();
  const navigate = useNavigate();
  const [scope, setScope] = useState<"active" | "all">("active");
  const q = useShipments(scope);
  const ready = useStatusCounts().data?.ready_for_shipment ?? 0;
  const create = useCreateShipment({ inlineErrors: true });
  const [creating, setCreating] = useState(false);
  const [partner, setPartner] = useState("");

  return (
    <>
      <PageHeader
        title={isV360 ? "Shipments" : "Incoming shipments"}
        description={isV360 ? "Consolidated shipments from the Lahore hub to KBB in Bangladesh." : "Shipments V360 has sent. Confirm receipt when a shipment reaches you; every order inside updates."}
        actions={<>
          <div role="radiogroup" className="flex rounded border border-line p-0.5 text-[13px]">
            {([["active", isV360 ? "Active" : "On the way"], ["all", "All"]] as const).map(([k, l]) => (
              <button key={k} role="radio" aria-checked={scope === k} onClick={() => setScope(k)} className={`rounded-[4px] px-3 py-1 ${scope === k ? "bg-sunken font-medium" : "text-muted"}`}>{l}</button>
            ))}
          </div>
          {isV360 && <Button variant="primary" onClick={() => { create.reset(); setPartner(""); setCreating(true); }}><Plus className="h-4 w-4" /> New shipment</Button>}
        </>} />

      {isV360 && ready > 0 && (
        <p className="mb-4 rounded-lg border border-g-brand/30 bg-g-brand-bg px-4 py-2.5 text-[13.5px] text-g-brand">
          {ready} order{ready > 1 ? "s are" : " is"} ready for shipment. Open a draft shipment, or create one, to add them.
        </p>
      )}

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13.5px]">
            <thead className="table-head"><tr><th>Shipment</th><th>Carrier</th><th>Tracking</th><th className="text-right">Orders</th><th className="text-right">Brands</th><th className="text-right">COD value</th><th>Status</th><th>Left hub</th></tr></thead>
            {q.isLoading ? <SkeletonRows cols={8} rows={4} /> : (
              <tbody className="table-body">
                {q.data!.map((s) => (
                  <tr key={s.id} onClick={() => navigate(`/shipments/${s.id}`)} className="cursor-pointer hover:bg-sunken/50">
                    <td><Link to={`/shipments/${s.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold hover:underline">{s.code}</Link></td>
                    <td>{s.shipping_partner ?? "—"}</td>
                    <td className="text-muted">{s.tracking_number ?? "—"}</td>
                    <td className="text-right">{s.order_count}</td>
                    <td className="text-right">{s.brand_count}</td>
                    <td className="whitespace-nowrap text-right">{fmtMoney(s.cod_expected, "BDT")}</td>
                    <td><Pill {...SHIPMENT_STATUS[s.status]} /></td>
                    <td className="whitespace-nowrap text-muted">{fmtDateTime(s.dispatched_at)}</td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && q.data!.length === 0 && (
          <EmptyState icon={<Ship className="h-6 w-6" />} title={isV360 ? "No shipments" : "No shipments on the way"}>
            {isV360 ? "Create a shipment, then add orders that are ready." : "When V360 dispatches a shipment to you, it appears here."}
          </EmptyState>
        )}
      </div>

      <ActionDialog open={creating} onClose={() => setCreating(false)} busy={create.isPending} error={create.error ? describeError(create.error) : null}
        title="New shipment" description="It starts as a draft. Add ready orders next, then set tracking and dispatch it."
        confirmLabel="Create shipment" noteLabel="Notes"
        onConfirm={(notes) => create.mutate({ partner, notes }, { onSuccess: (id) => { setCreating(false); navigate(`/shipments/${id}`); } })}>
        <TextField label="Shipping partner" optional list="carriers" value={partner} onChange={(e) => setPartner(e.target.value)} autoFocus />
        <datalist id="carriers">{["DHL", "Aramex", "FedEx", "TCS International", "Leopards International", "Cargo"].map((c) => <option key={c} value={c} />)}</datalist>
      </ActionDialog>
    </>
  );
}
