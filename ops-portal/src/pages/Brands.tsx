import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Settings } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import {
  useApproveBrand,
  useBrandMoneySettings,
  useBrands,
  useRejectBrand,
  useSaveBrandMoneySettings,
} from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { BrandRow } from "@/lib/types";
import type { StatusGroup } from "@/lib/status";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TextArea, TextField } from "@/components/ui/Field";
import { ActionDialog } from "@/components/ActionDialog";
import { EmptyState, ErrorState, SkeletonRows, Spinner } from "@/components/ui/States";

const conn = (b: BrandRow) => (Array.isArray(b.shopify_connections) ? b.shopify_connections[0] : b.shopify_connections) ?? null;
const SHOP: Record<string, { label: string; group: StatusGroup }> = {
  active: { label: "Connected", group: "done" }, pending: { label: "Not finished", group: "brand" },
  error: { label: "Error", group: "problem" }, uninstalled: { label: "Disconnected", group: "problem" },
};

function ApproveBrandDialog({ brand, open, onClose }: { brand: BrandRow; open: boolean; onClose: () => void }) {
  const approve = useApproveBrand({ inlineErrors: true });
  const [kbbPct, setKbbPct] = useState("8");
  const [v360Pct, setV360Pct] = useState("15");
  const [freightRate, setFreightRate] = useState("700");
  const [invoiceCompany, setInvoiceCompany] = useState("");
  const [note, setNote] = useState("");

  const submit = () => {
    const kbb = Number(kbbPct);
    const v360 = Number(v360Pct);
    const freight = Number(freightRate);
    if (Number.isNaN(kbb) || kbb < 0) return;
    if (Number.isNaN(v360) || v360 < 0) return;
    if (Number.isNaN(freight) || freight < 0) return;

    approve.mutate(
      {
        id: brand.id,
        note,
        kbbCommissionPct: kbb,
        v360CommissionPct: v360,
        freightBdtPerKg: freight,
        invoiceCompanyName: invoiceCompany,
      },
      { onSuccess: onClose }
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onSubmit={submit}
      busy={approve.isPending}
      error={approve.error ? describeError(approve.error) : null}
      width="lg"
      title={`Approve ${brand.name}`}
      description="Set financial and invoice settings for this brand before granting access."
      footer={
        <>
          <Button onClick={onClose} disabled={approve.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={approve.isPending}>
            Approve & Save Settings
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded border border-line bg-sunken/40 px-3 py-2 text-[12.5px] text-muted">
          Changing these affects new calculations only — existing statements and advances keep their snapshot.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <TextField
              label="KBB commission (%)"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={kbbPct}
              onChange={(e) => setKbbPct(e.target.value)}
              autoFocus
            />
            <p className="mt-1 text-[12px] text-muted">Kept by KBB from COD</p>
          </div>

          <div>
            <TextField
              label="V360 commission (%)"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={v360Pct}
              onChange={(e) => setV360Pct(e.target.value)}
            />
            <p className="mt-1 text-[12px] text-muted">Deducted from brand payables</p>
          </div>

          <div>
            <TextField
              label="Freight (BDT per kg)"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={freightRate}
              onChange={(e) => setFreightRate(e.target.value)}
            />
            <p className="mt-1 text-[12px] text-muted">Converted to PKR with the FX rate on the day weight is entered</p>
          </div>

          <div>
            <TextField
              label="Invoice company name (optional)"
              value={invoiceCompany}
              onChange={(e) => setInvoiceCompany(e.target.value)}
              optional
            />
            <p className="mt-1 text-[12px] text-muted">Shown on brand statements</p>
          </div>
        </div>

        <TextArea
          label="Internal review note"
          optional
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note for internal records"
        />
      </div>
    </Dialog>
  );
}

function EditBrandSettingsDialog({ brand, open, onClose }: { brand: BrandRow; open: boolean; onClose: () => void }) {
  const settings = useBrandMoneySettings(open ? brand.id : null);
  const save = useSaveBrandMoneySettings({ inlineErrors: true });
  const [kbbPct, setKbbPct] = useState("8");
  const [v360Pct, setV360Pct] = useState("15");
  const [freightRate, setFreightRate] = useState("700");
  const [invoiceCompany, setInvoiceCompany] = useState("");

  useEffect(() => {
    if (settings.data) {
      setKbbPct(String(settings.data.kbb_commission_pct ?? 8));
      setV360Pct(String(settings.data.v360_commission_pct ?? 15));
      setFreightRate(String(settings.data.freight_bdt_per_kg ?? 700));
      setInvoiceCompany(settings.data.invoice_company_name ?? "");
    }
  }, [settings.data]);

  const submit = () => {
    const kbb = Number(kbbPct);
    const v360 = Number(v360Pct);
    const freight = Number(freightRate);
    if (Number.isNaN(kbb) || kbb < 0) return;
    if (Number.isNaN(v360) || v360 < 0) return;
    if (Number.isNaN(freight) || freight < 0) return;

    save.mutate(
      {
        brandId: brand.id,
        kbbPct: kbb,
        v360Pct: v360,
        freightRate: freight,
        invoiceCompany,
      },
      { onSuccess: onClose }
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onSubmit={submit}
      busy={save.isPending || settings.isLoading}
      error={save.error ? describeError(save.error) : null}
      width="lg"
      title={`Brand Settings: ${brand.name}`}
      description="Financial and invoice settings used to compute payables and generate statements for this brand."
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save Settings
          </Button>
        </>
      }
    >
      {settings.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <p className="rounded border border-line bg-sunken/40 px-3 py-2 text-[12.5px] text-muted">
            Changing these affects new calculations only — existing statements and advances keep their snapshot.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <TextField
                label="KBB commission (%)"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={kbbPct}
                onChange={(e) => setKbbPct(e.target.value)}
                autoFocus
              />
              <p className="mt-1 text-[12px] text-muted">Kept by KBB from COD</p>
            </div>

            <div>
              <TextField
                label="V360 commission (%)"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={v360Pct}
                onChange={(e) => setV360Pct(e.target.value)}
              />
              <p className="mt-1 text-[12px] text-muted">Deducted from brand payables</p>
            </div>

            <div>
              <TextField
                label="Freight (BDT per kg)"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={freightRate}
                onChange={(e) => setFreightRate(e.target.value)}
              />
              <p className="mt-1 text-[12px] text-muted">Converted to PKR with the FX rate on the day weight is entered</p>
            </div>

            <div>
              <TextField
                label="Invoice company name (optional)"
                value={invoiceCompany}
                onChange={(e) => setInvoiceCompany(e.target.value)}
                optional
              />
              <p className="mt-1 text-[12px] text-muted">Shown on brand statements</p>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function Brands() {
  const { isAdmin } = useOps();
  const q = useBrands();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("approved");
  const reject = useRejectBrand({ inlineErrors: true });
  const [approveBrandRow, setApproveBrandRow] = useState<BrandRow | null>(null);
  const [editBrandRow, setEditBrandRow] = useState<BrandRow | null>(null);
  const [rejectBrandRow, setRejectBrandRow] = useState<BrandRow | null>(null);

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
                        {isAdmin && tab === "approved" && (
                          <Button size="sm" variant="ghost" onClick={() => setEditBrandRow(b)}>
                            <Settings className="mr-1 h-3.5 w-3.5" /> Settings
                          </Button>
                        )}
                        {isAdmin && tab !== "approved" && (
                          <Button size="sm" variant="primary" onClick={() => setApproveBrandRow(b)}>
                            Approve
                          </Button>
                        )}
                        {isAdmin && tab !== "rejected" && (
                          <Button size="sm" variant="danger-ghost" className="ml-1" onClick={() => { reject.reset(); setRejectBrandRow(b); }}>
                            {tab === "approved" ? "Suspend" : "Reject"}
                          </Button>
                        )}
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

      {approveBrandRow && (
        <ApproveBrandDialog
          brand={approveBrandRow}
          open={!!approveBrandRow}
          onClose={() => setApproveBrandRow(null)}
        />
      )}

      {editBrandRow && (
        <EditBrandSettingsDialog
          brand={editBrandRow}
          open={!!editBrandRow}
          onClose={() => setEditBrandRow(null)}
        />
      )}

      {rejectBrandRow && (
        <ActionDialog
          open
          onClose={() => setRejectBrandRow(null)}
          busy={reject.isPending}
          error={reject.error ? describeError(reject.error) : null}
          title={`${rejectBrandRow.approval_status === "approved" ? "Suspend" : "Reject"} ${rejectBrandRow.name}?`}
          description="They lose access to the brand portal immediately. The reason is shown to them."
          danger
          confirmLabel={rejectBrandRow.approval_status === "approved" ? "Suspend" : "Reject"}
          noteLabel="Reason (shown to the brand)"
          noteRequired
          onConfirm={(n) => reject.mutate({ id: rejectBrandRow.id, note: n }, { onSuccess: () => setRejectBrandRow(null) })}
        />
      )}
    </>
  );
}
