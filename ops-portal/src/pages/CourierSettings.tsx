import { useEffect, useState } from "react";
import { Copy, RefreshCw, Store, Truck } from "lucide-react";
import { toast } from "sonner";
import { useBrandOptions } from "@/hooks/useData";
import {
  COURIER_LABEL, REDX_DEFAULTS, useBrandStores, useCourierAccount, useCourierAction, useCourierAreas, useCourierSecrets,
  useRegenerateWebhookToken, useSaveCourierAccount, type CourierArea,
} from "@/hooks/useCourier";
import { describeError } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { ErrorState, Spinner } from "@/components/ui/States";
import { AreaPicker } from "@/components/CourierBookDialog";

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="panel mb-6 p-5">
      <h2>{title}</h2>
      {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function CourierSettings() {
  const acc = useCourierAccount();
  const secrets = useCourierSecrets(true);
  const areas = useCourierAreas();
  const stores = useBrandStores(acc.data?.id);
  const brands = useBrandOptions();
  const save = useSaveCourierAccount();
  const action = useCourierAction();
  const regen = useRegenerateWebhookToken();

  const [v, setV] = useState({
    enabled: false, environment: "sandbox" as "sandbox" | "production", baseUrl: REDX_DEFAULTS.sandbox, token: "",
    trackingTemplate: REDX_DEFAULTS.tracking, pickupPhone: "", pickupAddress: "", pickupArea: null as CourierArea | null,
  });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const a = acc.data;
    if (!a) return;
    setV({
      enabled: a.is_enabled, environment: a.environment, baseUrl: a.base_url, token: "", trackingTemplate: a.tracking_url_template,
      pickupPhone: a.pickup_phone ?? "", pickupAddress: a.pickup_address ?? "",
      pickupArea: a.pickup_area_id ? { area_id: a.pickup_area_id, name: a.pickup_area_name ?? String(a.pickup_area_id), post_code: null, district_name: null, division_name: null } : null,
    });
  }, [acc.data]);

  if (acc.isLoading || secrets.isLoading) return <Spinner label="Loading courier settings" />;
  if (acc.isError) return <ErrorState error={acc.error} onRetry={() => acc.refetch()} />;

  const tokenSet = secrets.data?.token_set ?? false;
  const webhookUrl = secrets.data?.webhook_token
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/courier-webhook?token=${secrets.data.webhook_token}` : "";
  const storeOf = new Map((stores.data ?? []).map((s) => [s.brand_id, s]));
  const missingStores = (brands.data ?? []).filter((b) => !storeOf.has(b.id)).length;

  const run = (body: Record<string, unknown>) => action.mutate(body, {
    onSuccess: (r) => {
      if (r.failed?.length) toast.error(`${r.message}. Not created: ${r.failed.join("; ")}`, { duration: 15000 });
      else toast.success(r.message ?? "Done");
    },
    onError: (e) => toast.error(describeError(e), { duration: 12000 }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (v.enabled && !tokenSet && !v.token.trim()) { setErr("Enter the API token before turning RedX on"); return; }
    save.mutate({
      enabled: v.enabled, environment: v.environment, baseUrl: v.baseUrl, token: v.token, trackingTemplate: v.trackingTemplate,
      pickupPhone: v.pickupPhone, pickupAddress: v.pickupAddress, pickupAreaId: v.pickupArea?.area_id ?? null, pickupAreaName: v.pickupArea?.name ?? "",
    }, { onSuccess: () => setV((s) => ({ ...s, token: "" })), onError: (e2) => setErr(describeError(e2)) });
  };

  const switchEnv = (env: "sandbox" | "production") => setV((s) => ({
    ...s, environment: env,
    // Swap the base URL only if it's still one of the defaults.
    baseUrl: s.baseUrl === REDX_DEFAULTS.sandbox || s.baseUrl === REDX_DEFAULTS.production ? REDX_DEFAULTS[env] : s.baseUrl,
  }));

  return (
    <>
      <PageHeader title="Courier settings" description={`Book deliveries with ${COURIER_LABEL} straight from Deliveries. Only KBB admins (and roles with "Manage courier settings") can change these.`} />

      <form onSubmit={submit} noValidate>
        <Section title={`${COURIER_LABEL} account`} description={`One ${COURIER_LABEL} merchant account for all brands. The token is stored encrypted and never shown again.`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-[14px] sm:col-span-2">
              <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--primary))]" />
              Use {COURIER_LABEL} for deliveries
            </label>
            <fieldset className="sm:col-span-2">
              <legend className="field-label">Mode</legend>
              <div className="flex gap-2">
                {(["sandbox", "production"] as const).map((env) => (
                  <label key={env} className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-[13.5px] ${v.environment === env ? "border-primary bg-primary-soft" : "border-line"}`}>
                    <input type="radio" name="env" checked={v.environment === env} onChange={() => switchEnv(env)} className="accent-[rgb(var(--primary))]" />
                    {env === "sandbox" ? "Test (sandbox)" : "Live (production)"}
                  </label>
                ))}
              </div>
            </fieldset>
            <TextField label="API base URL" value={v.baseUrl} onChange={(e) => setV({ ...v, baseUrl: e.target.value })}
              hint={`Copy it from your ${COURIER_LABEL} merchant panel → Developer API if it differs.`} />
            <TextField label="API token" type="password" autoComplete="off" value={v.token} onChange={(e) => setV({ ...v, token: e.target.value })}
              placeholder={tokenSet ? "Saved — leave blank to keep it" : "Paste the token"} hint={tokenSet ? "A token is saved." : "No token saved yet."} />
            <div className="sm:col-span-2">
              <TextField label="Tracking link" value={v.trackingTemplate} onChange={(e) => setV({ ...v, trackingTemplate: e.target.value })}
                hint="{tracking} is replaced by the tracking number. This link is saved on the order and sent to Shopify." />
            </div>
          </div>
        </Section>

        <Section title="KBB pickup details" description="Every brand's pickup store uses this address and phone, under the brand's own name.">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Pickup phone" value={v.pickupPhone} onChange={(e) => setV({ ...v, pickupPhone: e.target.value })} placeholder="01XXXXXXXXX" />
            <div>
              <span className="field-label">Pickup area</span>
              {areas.data?.length ? (
                <AreaPicker id="pickup-area" areas={areas.data} value={v.pickupArea} onChange={(a) => setV({ ...v, pickupArea: a })} />
              ) : <p className="text-[13px] text-muted">Save the token, then download {COURIER_LABEL} areas below to choose.</p>}
            </div>
            <div className="sm:col-span-2">
              <TextField label="Pickup address" value={v.pickupAddress} onChange={(e) => setV({ ...v, pickupAddress: e.target.value })} />
            </div>
          </div>
        </Section>

        {err && <p role="alert" className="mb-4 text-[13.5px] text-danger">{err}</p>}
        <div className="mb-8 flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={save.isPending}>Save settings</Button>
          <Button type="button" disabled={!tokenSet || action.isPending} onClick={() => run({ action: "test" })}>Test connection</Button>
          <Button type="button" disabled={!tokenSet || action.isPending} onClick={() => run({ action: "sync_areas" })}>
            <RefreshCw className="h-4 w-4" /> Download areas{areas.data?.length ? ` (${areas.data.length})` : ""}
          </Button>
        </div>
      </form>

      <Section title="Status updates (webhook)" description={`${COURIER_LABEL} calls this address whenever a parcel's status changes. Paste it into your ${COURIER_LABEL} merchant panel → Developer API → Webhook → Callback URL, and enable the webhook.`}>
        {webhookUrl ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded border border-line bg-sunken px-2 py-1.5 text-[12.5px]">{webhookUrl}</code>
              <Button size="sm" onClick={() => { void navigator.clipboard.writeText(webhookUrl); toast.success("Copied"); }}><Copy className="h-4 w-4" /> Copy</Button>
              <Button size="sm" variant="ghost" loading={regen.isPending} onClick={() => regen.mutate()}>New address</Button>
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-muted">
              <li>Rider picks the parcel up → order becomes <b>Out for delivery</b> and the tracking goes to Shopify.</li>
              <li>Delivered → order becomes <b>Delivered</b>, with the booked COD amount recorded as collected.</li>
              <li>Hold, returning, returned, area change and payouts are only noted on the order's timeline. Update failed or returned orders yourself.</li>
              <li>Treat this address like a password. If it leaks, click "New address" and update it in {COURIER_LABEL}.</li>
            </ul>
          </>
        ) : <p className="text-[13.5px] text-muted">Save the settings once to get your webhook address.</p>}
      </Section>

      <Section title="Brand pickup stores" description={`Each brand is booked with ${COURIER_LABEL} under its own name. Stores are created automatically on a brand's first booking, or all at once here.`}>
        <div className="mb-3 flex items-center gap-3">
          <Button disabled={!tokenSet || !acc.data?.pickup_area_id || action.isPending || missingStores === 0} onClick={() => run({ action: "sync_stores" })}>
            <Store className="h-4 w-4" /> Create missing stores{missingStores ? ` (${missingStores})` : ""}
          </Button>
          {!acc.data?.pickup_area_id && <span className="text-[12.5px] text-muted">Save the pickup phone, address and area first.</span>}
        </div>
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead className="table-head"><tr><th>Brand</th><th>{COURIER_LABEL} store</th><th>Store id</th><th>Created</th></tr></thead>
            <tbody className="table-body">
              {(brands.data ?? []).map((b) => {
                const s = storeOf.get(b.id);
                return (
                  <tr key={b.id}>
                    <td className="font-medium">{b.name}</td>
                    <td>{s ? s.store_name : <span className="text-faint">Not created yet</span>}</td>
                    <td className="text-muted">{s?.store_id ?? "—"}</td>
                    <td className="text-muted">{s ? fmtDateTime(s.created_at) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!brands.data?.length && <p className="text-[13px] text-muted"><Truck className="mr-1 inline h-4 w-4" />No brands yet.</p>}
      </Section>
    </>
  );
}
