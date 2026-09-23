import { useState } from "react";
import { Coins } from "lucide-react";
import { useAddFxRate, useFxRates } from "@/hooks/useData";
import { fmtDate, fmtDateTime, todayISO } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

export function FxRates() {
  const q = useFxRates();
  const add = useAddFxRate();
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
      <PageHeader title="FX rates" description="Enter the day's rate manually. Settlements will use the rate for the day they're made; saving the same date again replaces it." />
      {stale && <p className="mb-4 rounded-lg border border-g-brand/30 bg-g-brand-bg px-4 py-2.5 text-[13.5px] text-g-brand">No BDT to PKR rate entered for today. The last one is from {fmtDate(latest.rate_date)}.</p>}
      <form onSubmit={submit} noValidate className="panel mb-6 grid items-start gap-4 p-4 sm:grid-cols-[150px_90px_90px_150px_1fr_auto]">
        <TextField label="Date" type="date" max={todayISO()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} error={errs.date} />
        <TextField label="From" value={v.base} maxLength={3} onChange={(e) => setV({ ...v, base: e.target.value.toUpperCase() })} error={errs.base} />
        <TextField label="To" value={v.quote} maxLength={3} onChange={(e) => setV({ ...v, quote: e.target.value.toUpperCase() })} error={errs.quote} />
        <TextField label={`1 ${v.base || "…"} =`} inputMode="decimal" placeholder="e.g. 2.31" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} error={errs.rate} />
        <TextField label="Source / note" optional value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. Bank rate" />
        <Button type="submit" variant="primary" loading={add.isPending} className="sm:mt-[26px]">Save rate</Button>
      </form>
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
                  <td className="text-muted">{r.note ?? "—"}</td>
                  <td className="text-muted">{fmtDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && q.data!.length === 0 && <EmptyState icon={<Coins className="h-6 w-6" />} title="No rates yet">Enter today's BDT to PKR rate above.</EmptyState>}
      </div>
    </>
  );
}
