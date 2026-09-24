import { useEffect, useState } from "react";
import { Banknote, FileText, Receipt, Settings2, Wallet } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import {
  useBrandPayables, useKbbAccount, useKbbPayments, useMoneySettings, useSettlements, useUpdateMoneySettings,
} from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import type { KbbPaymentKind } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";
import { CreateSettlementDialog, RecordPaymentDialog, StatementDialog } from "@/components/MoneyDialogs";

type Tab = "payables" | "statements" | "account" | "settings";

const PAYMENT_KIND: Record<KbbPaymentKind, string> = {
  dispatch_advance: "Dispatch advance",
  delivery_balance: "Delivery payment",
  credit: "Credit / refund",
};

export function Money() {
  const { isV360 } = useOps();
  const [tab, setTab] = useState<Tab>(isV360 ? "payables" : "account");
  const tabs: { key: Tab; label: string }[] = isV360
    ? [
        { key: "payables", label: "Brand payables" },
        { key: "statements", label: "Statements" },
        { key: "account", label: "KBB account" },
        { key: "settings", label: "Settings" },
      ]
    : [{ key: "account", label: "My account" }];

  useEffect(() => { if (!isV360 && tab !== "account") setTab("account"); }, [isV360, tab]);

  return (
    <>
      <PageHeader
        title={isV360 ? "Money" : "My account"}
        description={isV360
          ? "Commissions, freight, KBB advances, and brand statements."
          : "Advances, delivery payments, and credits for each shipment."}
      />
      <div role="tablist" className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-line px-1">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] ${tab === t.key ? "border-primary font-medium" : "border-transparent text-muted hover:text-ink"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "payables" && isV360 && <PayablesTab />}
      {tab === "statements" && isV360 && <StatementsTab />}
      {tab === "account" && <AccountTab canRecord={isV360} />}
      {tab === "settings" && isV360 && <SettingsTab />}
    </>
  );
}

// ---------------------------------------------------------------- payables

function PayablesTab() {
  const q = useBrandPayables();
  const [creating, setCreating] = useState(false);
  const rows = q.data ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-muted">Delivered orders not yet on a statement. Create a statement to settle them.</p>
        <Button variant="primary" onClick={() => setCreating(true)}><FileText className="h-4 w-4" /> Create statement</Button>
      </div>
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13.5px]">
            <thead className="table-head"><tr>
              <th>Brand</th><th className="text-right">Orders</th>
              <th className="text-right">Order total</th><th className="text-right">Commission</th>
              <th className="text-right">Freight</th><th className="text-right">Payable</th><th />
            </tr></thead>
            {q.isLoading ? <SkeletonRows cols={7} rows={4} /> : (
              <tbody className="table-body">
                {rows.map((r) => (
                  <tr key={r.brand_id}>
                    <td className="font-medium">{r.brand_name}</td>
                    <td className="text-right">{r.order_count}</td>
                    <td className="text-right">{fmtMoney(r.order_total_sum, "PKR")}</td>
                    <td className="text-right text-danger">−{fmtMoney(r.commission_sum, "PKR")}</td>
                    <td className="text-right text-danger">−{fmtMoney(r.freight_sum, "PKR")}</td>
                    <td className="text-right font-semibold">{fmtMoney(r.payable_sum, "PKR")}</td>
                    <td className="text-right">
                      <Button size="sm" onClick={() => setCreating(true)}>Create statement</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <EmptyState icon={<Banknote className="h-6 w-6" />} title="Nothing owed yet">
            Brands show up here once they have delivered orders that aren't on a statement.
          </EmptyState>
        )}
      </div>
      <CreateSettlementDialog open={creating} onClose={() => setCreating(false)} onCreated={() => void 0} />
    </>
  );
}

// ---------------------------------------------------------------- statements

function StatementsTab() {
  const q = useSettlements();
  const [viewId, setViewId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const rows = q.data ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-muted">Monthly and pay-now statements issued to brands.</p>
        <Button variant="primary" onClick={() => setCreating(true)}><FileText className="h-4 w-4" /> Create statement</Button>
      </div>
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead className="table-head"><tr>
              <th>#</th><th>Brand</th><th>Period</th><th>Status</th>
              <th className="text-right">Orders</th><th className="text-right">Payable</th>
              <th>Created</th><th />
            </tr></thead>
            {q.isLoading ? <SkeletonRows cols={8} rows={4} /> : (
              <tbody className="table-body">
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className="font-medium">#{s.id}</td>
                    <td>{s.brand?.name ?? "—"}</td>
                    <td className="text-muted">
                      {s.kind === "monthly" && s.period_start && s.period_end
                        ? `${fmtDate(s.period_start)} – ${fmtDate(s.period_end)}`
                        : "All outstanding"}
                    </td>
                    <td><Pill group={s.status === "paid" ? "done" : "brand"} label={s.status === "paid" ? "Paid" : "Issued"} /></td>
                    <td className="text-right">{s.order_count}</td>
                    <td className="text-right font-semibold">{fmtMoney(s.total_payable, "PKR")}</td>
                    <td className="text-muted">{fmtDate(s.created_at)}</td>
                    <td className="text-right"><Button size="sm" onClick={() => setViewId(s.id)}>View</Button></td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <EmptyState icon={<Receipt className="h-6 w-6" />} title="No statements yet">
            Create one from Brand payables once a brand has delivered orders.
          </EmptyState>
        )}
      </div>
      <CreateSettlementDialog open={creating} onClose={() => setCreating(false)} onCreated={() => void 0} />
      <StatementDialog settlementId={viewId} open={viewId !== null} onClose={() => setViewId(null)} />
    </>
  );
}

// ---------------------------------------------------------------- KBB account

function AccountTab({ canRecord }: { canRecord: boolean }) {
  const q = useKbbAccount();
  const pays = useKbbPayments();
  const [recording, setRecording] = useState(false);
  const rows = q.data ?? [];
  const totalNet = rows.reduce((n, r) => n + Number(r.net_balance), 0);
  const outstanding = rows.filter((r) => Number(r.net_balance) !== 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-muted">
          Per-order advances owed, delivery payments, and credits. Positive net = KBB still to pay.
        </p>
        {canRecord && <Button variant="primary" onClick={() => setRecording(true)}><Wallet className="h-4 w-4" /> Record payment</Button>}
      </div>

      <div className="panel mb-6 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-[13.5px]">
            <thead className="table-head"><tr>
              <th>Order</th><th>Ordered</th>
              <th className="text-right">Order value</th>
              <th className="text-right">Advance owed</th><th className="text-right">Advance paid</th>
              <th className="text-right">Delivery owed</th><th className="text-right">Delivery paid</th>
              <th className="text-right">Credits</th><th className="text-right">Net balance</th>
            </tr></thead>
            {q.isLoading ? <SkeletonRows cols={9} rows={4} /> : (
              <tbody className="table-body">
                {rows.map((r) => (
                  <tr key={r.order_id}>
                    <td>
                      <span className="font-medium">{r.order_number}</span>
                      <span className="ml-1.5 text-[12px] text-muted">{r.shipment_code}</span>
                    </td>
                    <td className="text-muted">{fmtDateTime(r.order_date)}</td>
                    <td className="text-right text-muted">{fmtMoney(r.order_value_pkr, "PKR")}</td>
                    <td className="text-right">{fmtMoney(r.advance_owed, "PKR")}</td>
                    <td className="text-right">{fmtMoney(r.advance_paid, "PKR")}</td>
                    <td className="text-right">{fmtMoney(r.delivery_owed, "PKR")}</td>
                    <td className="text-right">{fmtMoney(r.delivery_paid, "PKR")}</td>
                    <td className="text-right text-g-done">{Number(r.credits) ? fmtMoney(r.credits, "PKR") : "—"}</td>
                    <td className={`text-right font-semibold ${Number(r.net_balance) > 0 ? "text-g-problem" : Number(r.net_balance) < 0 ? "text-g-done" : ""}`}>
                      {fmtMoney(r.net_balance, "PKR")}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <EmptyState icon={<Banknote className="h-6 w-6" />} title="No dispatched orders yet">
            Balances appear once an order leaves the hub.
          </EmptyState>
        )}
        {!q.isLoading && rows.length > 0 && (
          <div className="flex justify-end border-t border-line px-4 py-2.5 text-[13.5px]">
            Total outstanding: <strong className="ml-1.5">{fmtMoney(totalNet, "PKR")}</strong>
            {outstanding.length > 0 && <span className="ml-2 text-muted">({outstanding.length} order{outstanding.length === 1 ? "" : "s"})</span>}
          </div>
        )}
      </div>

      <section className="panel overflow-hidden">
        <div className="border-b border-line px-4 py-3"><h2>Recent payments</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13.5px]">
            <thead className="table-head"><tr>
              <th>Date</th><th>Type</th><th>Against</th>
              <th className="text-right">Amount</th><th className="text-right">PKR</th><th>Note</th>
            </tr></thead>
            {pays.isLoading ? <SkeletonRows cols={6} rows={4} /> : (
              <tbody className="table-body">
                {(pays.data ?? []).map((p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap text-muted">{fmtDate(p.payment_date)}</td>
                    <td><Pill group={p.kind === "credit" ? "done" : "transit"} label={PAYMENT_KIND[p.kind]} /></td>
                    <td className="text-muted">{p.shipment?.code ?? p.order?.order_number ?? "—"}</td>
                    <td className="text-right">{fmtMoney(p.amount, p.currency)}</td>
                    <td className="text-right font-semibold">{fmtMoney(p.amount_pkr, "PKR")}</td>
                    <td className="max-w-[200px] truncate text-muted">{p.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {pays.isError && <ErrorState error={pays.error} onRetry={() => pays.refetch()} />}
        {!pays.isLoading && !pays.isError && (pays.data ?? []).length === 0 && (
          <EmptyState title="No payments recorded">Advances and delivery payments show up here.</EmptyState>
        )}
      </section>

      {canRecord && <RecordPaymentDialog open={recording} onClose={() => setRecording(false)} account={rows} />}
    </>
  );
}

// ---------------------------------------------------------------- settings

function SettingsTab() {
  const q = useMoneySettings();
  const save = useUpdateMoneySettings({ inlineErrors: true });
  const [v, setV] = useState({ kbb: "", v360: "", freight: "", company: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const loaded = q.data;

  useEffect(() => {
    if (!loaded) return;
    setV({
      kbb: loaded.kbb_commission_pct !== undefined ? String(loaded.kbb_commission_pct) : "",
      v360: loaded.v360_commission_pct !== undefined ? String(loaded.v360_commission_pct) : "",
      freight: loaded.freight_bdt_per_kg !== undefined ? String(loaded.freight_bdt_per_kg) : "",
      company: loaded.invoice_company_name ?? "",
    });
  }, [loaded]);

  const dirty = !!loaded && (
    v.kbb !== String(loaded.kbb_commission_pct ?? "") ||
    v.v360 !== String(loaded.v360_commission_pct ?? "") ||
    v.freight !== String(loaded.freight_bdt_per_kg ?? "") ||
    v.company !== (loaded.invoice_company_name ?? "")
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    const num = (s: string, name: string, min: number, max: number) => {
      const n = Number(s);
      if (!s.trim() || Number.isNaN(n) || n < min || n >= max) er[name] = `Enter a number from ${min} to under ${max}`;
      return Number.isNaN(n) ? 0 : n;
    };
    const kbb = num(v.kbb, "kbb", 0, 100);
    const v360 = num(v.v360, "v360", 0, 100);
    const freight = num(v.freight, "freight", 0, 1e9);
    setErrs(er);
    if (Object.keys(er).length) return;
    save.mutate({ kbbPct: kbb, v360Pct: v360, freightRate: freight, invoiceCompany: v.company });
  };

  if (q.isLoading) return <div className="panel"><SkeletonRows cols={4} rows={2} /></div>;
  if (q.isError) return <div className="panel"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;

  return (
    <form onSubmit={submit} noValidate className="panel grid max-w-3xl items-start gap-4 p-4 sm:grid-cols-2">
      <div className="sm:col-span-2 flex items-center gap-2 text-muted">
        <Settings2 className="h-4 w-4" aria-hidden />
        <p className="text-[13px]">Changing these affects new calculations only — existing statements and advances keep their snapshot.</p>
      </div>
      <TextField label="KBB commission (%)" inputMode="decimal" value={v.kbb} onChange={(e) => setV({ ...v, kbb: e.target.value })} error={errs.kbb} hint="Kept by KBB from COD" />
      <TextField label="V360 commission (%)" inputMode="decimal" value={v.v360} onChange={(e) => setV({ ...v, v360: e.target.value })} error={errs.v360} hint="Deducted from brand payables" />
      <TextField label="Freight (BDT per kg)" inputMode="decimal" value={v.freight} onChange={(e) => setV({ ...v, freight: e.target.value })} error={errs.freight} hint="Converted to PKR with the FX rate on the day weight is entered" />
      <TextField label="Invoice company name" optional value={v.company} onChange={(e) => setV({ ...v, company: e.target.value })} hint="Shown on brand statements" />
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>Save settings</Button>
        {save.error && <p role="alert" className="mt-2 text-[13px] text-danger">{describeError(save.error)}</p>}
      </div>
    </form>
  );
}
