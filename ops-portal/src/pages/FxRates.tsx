import { useState } from "react";
import { Coins, RefreshCw } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useAddFxRate, useFxRates, useSyncFxRates } from "@/hooks/useData";
import { fmtDate, fmtDateTime, todayISO } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

export function FxRates() {
  const canManage = useOps().can("fx.manage");
  const q = useFxRates();
  const add = useAddFxRate();
  const sync = useSyncFxRates();
  const [v, setV] = useState({ date: todayISO(), base: "BDT", quote: "PKR", rate: "", note: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const latest = q.data?.find((r) => r.base === "BDT" && r.quote === "PKR");
  const stale = latest && latest.rate_date < todayISO();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    const n = Number(v.rate);
    if (!v.rate.trim() || Number.isNaN(n) || n <= 0) er.rate = "Enter a positive rate";
    if (!/^[A-Za-z]{3}$/.test(v.base)) er.base = "3-letter code";
    if (!/^[A-Za-z]{3}$/.test(v.quote)) er.quote = "3-letter code";
    if (!v.date) er.date = "Choose a date";
    setErrs(er);
    if (!Object.keys(er).length) add.mutate({ ...v, rate: n }, { onSuccess: () => setV((s) => ({ ...s, rate: "", note: "" })) });
  };

  return (
    <>
      <PageHeader
        title="FX rates"
        description="The BDT rate is fetched automatically several times a day. A rate you enter yourself for a date replaces the automatic one and is never overwritten. Each order uses the rate of its order date."
        actions={canManage && (
          <Button onClick={() => sync.mutate()} loading={sync.isPending}><RefreshCw className="h-4 w-4" /> Fetch today's rate</Button>
        )}
      />
      {stale && <p className="mb-4 rounded-lg border border-g-brand/30 bg-g-brand-bg px-4 py-2.5 text-[13.5px] text-g-brand">No BDT to PKR rate for today yet. The last one is from {fmtDate(latest.rate_date)}.</p>}
      {canManage && <form onSubmit={submit} noValidate className="panel mb-6 grid items-start gap-4 p-4 sm:grid-cols-[150px_90px_90px_150px_1fr_auto]">
        <TextField label="Date" type="date" max={todayISO()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} error={errs.date} />
        <TextField label="From" value={v.base} maxLength={3} onChange={(e) => setV({ ...v, base: e.target.value.toUpperCase() })} error={errs.base} />
        <TextField label="To" value={v.quote} maxLength={3} onChange={(e) => setV({ ...v, quote: e.target.value.toUpperCase() })} error={errs.quote} />
        <TextField label={`1 ${v.base || "…"} =`} inputMode="decimal" placeholder="e.g. 2.31" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} error={errs.rate} />
        <TextField label="Source / note" optional value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. Bank rate" />
        <Button type="submit" variant="primary" loading={add.isPending} className="sm:mt-[26px]">Save rate</Button>
      </form>}
      <div className="panel overflow-hidden">
        <table className="w-full text-[13.5px]">
          <thead className="table-head"><tr><th>Date</th><th>Pair</th><th className="text-right">Rate</th><th>Note</th><th>Entered</th></tr></thead>
          {q.isLoading ? <SkeletonRows cols={5} rows={4} /> : (
            <tbody className="table-body">
              {q.data!.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{fmtDate(r.rate_date)}</td>
                  <td>1 {r.base} to {r.quote}</td>
                  <td className="text-right font-semibold">{Number(r.rate).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                  <td className="text-muted">
                    {r.note?.startsWith("Auto:") ? <span className="rounded bg-sunken px-1.5 py-0.5 text-[12px] font-medium text-ink">Auto</span> : null}
                    {r.note?.startsWith("Auto:") ? ` ${r.note.slice(5).trim()}` : r.note ?? "—"}
                  </td>
                  <td className="text-muted">{fmtDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && q.data!.length === 0 && <EmptyState icon={<Coins className="h-6 w-6" />} title="No rates yet">Fetch today's rate, or enter one above.</EmptyState>}
      </div>
      <p className="mt-3 text-[12px] text-faint">
        <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer" className="link">Rates By Exchange Rate API</a>
      </p>
    </>
  );
}
