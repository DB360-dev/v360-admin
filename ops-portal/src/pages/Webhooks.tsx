import { useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import {
  useReplayWebhook, useSaveShopifyCredentials, useShopifyCredentialsStatus, useWebhooks,
} from "@/hooks/useData";
import { fmtDateTime } from "@/lib/format";
import { describeError } from "@/lib/errors";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

function SetBadge({ set }: { set: boolean | undefined }) {
  if (set === undefined) return <span className="text-faint">…</span>;
  return set
    ? <Pill group="done" label="Saved" />
    : <Pill group="problem" label="Not set" />;
}

/** Two fields that write the Shopify app Client ID + Secret into Supabase Vault. */
function ShopifyCredentials() {
  const { isAdmin } = useOps();
  const status = useShopifyCredentialsStatus(isAdmin);
  const save = useSaveShopifyCredentials({ inlineErrors: true });
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);

  if (!isAdmin) return null;

  const st = status.data;
  const err = save.error ? describeError(save.error) : localErr;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalErr(null);
    const key = apiKey.trim();
    const secret = apiSecret.trim();

    if (!key && !secret) {
      setLocalErr("Enter the Shopify Client ID and/or Secret to update");
      return;
    }
    if (!st?.client_id_set && !key) {
      setLocalErr("Shopify Client ID is required");
      return;
    }
    if (!st?.secret_set && !secret) {
      setLocalErr("Shopify Secret is required");
      return;
    }

    save.mutate({ apiKey: key, apiSecret: secret }, {
      onSuccess: () => {
        setApiKey("");
        setApiSecret("");
        setLocalErr(null);
      },
    });
  };

  return (
    <section className="panel mb-6">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div>
          <h2>Shopify app credentials</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Client ID and Secret used for OAuth and webhook signatures. Stored in Supabase Vault — values are never shown again after saving.
            Leave a field blank to keep the current value.
          </p>
        </div>
      </div>
      <form onSubmit={submit} noValidate className="grid gap-4 p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <TextField
            label="Shopify Client ID"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={st?.client_id_set ? "••••••••  (enter to replace)" : "e.g. abc123…"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <SetBadge set={status.isLoading ? undefined : st?.client_id_set} />
            <span className="text-faint">SHOPIFY_API_KEY</span>
          </div>
        </div>
        <div className="space-y-1.5">
          <TextField
            label="Shopify Secret"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={st?.secret_set ? "••••••••  (enter to replace)" : "Your app client secret"}
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
          />
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <SetBadge set={status.isLoading ? undefined : st?.secret_set} />
            <span className="text-faint">SHOPIFY_API_SECRET</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="primary" loading={save.isPending}>Save credentials</Button>
          {st?.updated_at && (
            <span className="text-[12.5px] text-faint">Last updated {fmtDateTime(st.updated_at)}</span>
          )}
          {status.isError && (
            <button type="button" onClick={() => status.refetch()} className="link text-[12.5px]">Retry status</button>
          )}
        </div>
        {err && <p role="alert" className="text-[13px] text-danger sm:col-span-2">{err}</p>}
      </form>
    </section>
  );
}

export function Webhooks() {
  const { isV360 } = useOps();
  const [failed, setFailed] = useState(true);
  const q = useWebhooks(failed);
  const replay = useReplayWebhook();

  return (
    <>
      <PageHeader title="Shopify sync" description="Order notifications received from brands' Shopify stores. Fix the cause of a failure, then replay it."
        actions={<div role="radiogroup" className="flex rounded border border-line p-0.5 text-[13px]">
          {([[true, "Failed"], [false, "All recent"]] as const).map(([k, l]) => (
            <button key={String(k)} role="radio" aria-checked={failed === k} onClick={() => setFailed(k)} className={`rounded-[4px] px-3 py-1 ${failed === k ? "bg-sunken font-medium" : "text-muted"}`}>{l}</button>
          ))}
        </div>} />

      <ShopifyCredentials />

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead className="table-head"><tr><th>Received</th><th>Store</th><th>Event</th><th>Result</th><th /></tr></thead>
            {q.isLoading ? <SkeletonRows cols={5} rows={4} /> : (
              <tbody className="table-body">
                {q.data!.map((w) => (
                  <tr key={w.id}>
                    <td className="whitespace-nowrap text-muted">{fmtDateTime(w.received_at)}</td>
                    <td>{w.shop_domain}</td>
                    <td className="text-muted">{w.topic}</td>
                    <td className="max-w-[340px]">
                      {w.error ? <span className="text-g-problem">{w.error}</span>
                        : w.processed_at ? <Pill group="done" label="Processed" /> : <Pill group="v360" label="Processing" />}
                    </td>
                    <td className="text-right">{isV360 && w.error && (
                      <Button size="sm" loading={replay.isPending && replay.variables === w.webhook_id} onClick={() => replay.mutate(w.webhook_id)}>Replay</Button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && q.data!.length === 0 && (
          <EmptyState icon={<CheckCircle2 className="h-6 w-6 text-g-done" />} title={failed ? "No failed syncs" : "Nothing received yet"}>
            {failed ? "Every Shopify order notification was processed." : "Notifications appear once a brand connects Shopify."}
          </EmptyState>
        )}
      </div>
    </>
  );
}
