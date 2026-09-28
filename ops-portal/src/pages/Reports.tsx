import { useMemo, useState } from "react";
import { Download, FileSpreadsheet } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useBrandOptions, useShipments } from "@/hooks/useData";
import { downloadWorkbook } from "@/lib/excel";
import { describeError } from "@/lib/errors";
import { STATUS } from "@/lib/status";
import type { OrderStatus } from "@/lib/types";
import { reportsFor } from "@/reports";
import type { ReportDef, ReportFilters } from "@/reports/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TextField } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/States";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

const PRESETS: { label: string; from: () => string | null; to: () => string | null }[] = [
  { label: "Last 7 days", from: () => daysAgo(6), to: () => iso(new Date()) },
  { label: "Last 30 days", from: () => daysAgo(29), to: () => iso(new Date()) },
  { label: "This month", from: () => iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), to: () => iso(new Date()) },
  { label: "Last 90 days", from: () => daysAgo(89), to: () => iso(new Date()) },
  { label: "All time", from: () => null, to: () => null },
];

function ReportDialog({ report, onClose }: { report: ReportDef; onClose: () => void }) {
  const { can, orgName } = useOps();
  const brands = useBrandOptions();
  const shipments = useShipments("all");
  const needs = (k: ReportDef["filters"][number]) => report.filters.includes(k);
  const [f, setF] = useState<ReportFilters>({
    from: needs("dateRange") ? daysAgo(29) : null, to: needs("dateRange") ? iso(new Date()) : null,
    brandId: null, brandName: null, status: null, shipmentId: null, shipmentCode: null,
  });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (report.required?.includes("shipment") && !f.shipmentId) { setError("Choose a shipment"); return; }
    if (f.from && f.to && f.from > f.to) { setError("The start date is after the end date"); return; }
    setBusy(true); setError(null); setProgress("Loading…");
    try {
      const showMoney = can("orders.view_money");
      const spec = await report.run(f, { showMoney, can, orgName, progress: setProgress });
      setProgress("Building the Excel file…");
      await downloadWorkbook(spec, { showMoney, author: orgName ?? undefined });
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false); setProgress("");
    }
  };

  return (
    <Dialog open onClose={onClose} onSubmit={run} busy={busy} error={error}
      title={`${report.code} · ${report.title}`} description={report.description}
      footer={<>
        {busy && <span className="mr-auto text-[13px] text-muted">{progress}</span>}
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}><Download className="h-4 w-4" /> Download Excel</Button>
      </>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {needs("dateRange") && (
          <>
            <div className="flex flex-wrap gap-1.5 sm:col-span-2">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => setF({ ...f, from: p.from(), to: p.to() })}
                  className="rounded-full border border-line px-2.5 py-1 text-[12.5px] text-muted hover:border-faint hover:text-ink">{p.label}</button>
              ))}
            </div>
            <TextField label="From" type="date" value={f.from ?? ""} max={iso(new Date())} onChange={(e) => setF({ ...f, from: e.target.value || null })} />
            <TextField label="To" type="date" value={f.to ?? ""} max={iso(new Date())} onChange={(e) => setF({ ...f, to: e.target.value || null })} />
          </>
        )}
        {needs("brand") && (
          <label className="block">
            <span className="field-label">Brand</span>
            <select className="input" value={f.brandId ?? ""} onChange={(e) => {
              const b = (brands.data ?? []).find((x) => x.id === e.target.value);
              setF({ ...f, brandId: b?.id ?? null, brandName: b?.name ?? null });
            }}>
              <option value="">All brands</option>
              {(brands.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
        {needs("status") && (
          <label className="block">
            <span className="field-label">Status</span>
            <select className="input" value={f.status ?? ""} onChange={(e) => setF({ ...f, status: e.target.value || null })}>
              <option value="">All statuses</option>
              {(Object.keys(STATUS) as OrderStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
            </select>
          </label>
        )}
        {needs("shipment") && (
          <label className="block sm:col-span-2">
            <span className="field-label">Shipment{report.required?.includes("shipment") ? "" : " (optional)"}</span>
            <select className="input" value={f.shipmentId ?? ""} onChange={(e) => {
              const s = (shipments.data ?? []).find((x) => x.id === e.target.value);
              setF({ ...f, shipmentId: s?.id ?? null, shipmentCode: s?.code ?? null });
            }}>
              <option value="">{report.required?.includes("shipment") ? "Choose a shipment…" : "All shipments"}</option>
              {(shipments.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}{s.tracking_number ? ` · ${s.tracking_number}` : ""}</option>)}
            </select>
          </label>
        )}
        {!report.filters.length && <p className="text-[13.5px] text-muted sm:col-span-2">This report has no filters: it covers everything you can see.</p>}
      </div>
      {!can("orders.view_money") && <p className="mt-4 text-[12.5px] text-faint">Money columns are left out because your role can't see money amounts.</p>}
    </Dialog>
  );
}

export function Reports() {
  const { role, can } = useOps();
  const list = useMemo(() => reportsFor(role, can), [role, can]);
  const [open, setOpen] = useState<ReportDef | null>(null);
  const [q, setQ] = useState("");
  const shown = list.filter((r) => !q || `${r.code} ${r.title} ${r.description} ${r.category}`.toLowerCase().includes(q.toLowerCase()));
  const categories = [...new Set(shown.map((r) => r.category))];

  return (
    <>
      <PageHeader title="Reports" description="Download any report as an Excel file. You only see the reports your role allows." />
      <input className="input mb-5 max-w-sm" placeholder="Search reports…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search reports" />
      {list.length === 0 ? (
        <EmptyState icon={<FileSpreadsheet className="h-6 w-6" />} title="No reports for your role">Ask your admin to add reports to your role.</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="No reports match">Try a different search.</EmptyState>
      ) : categories.map((c) => (
        <section key={c} className="mb-7">
          <h2 className="mb-3">{c}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.filter((r) => r.category === c).map((r) => (
              <li key={r.code}>
                <button type="button" onClick={() => setOpen(r)}
                  className="panel flex h-full w-full items-start gap-3 p-4 text-left hover:border-faint">
                  <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-g-done" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold">{r.title} <span className="ml-1 text-[11.5px] font-normal text-faint">{r.code}</span></span>
                    <span className="mt-0.5 block text-[13px] text-muted">{r.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {open && <ReportDialog report={open} onClose={() => setOpen(null)} />}
    </>
  );
}
