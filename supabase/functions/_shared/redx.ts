// Minimal RedX OpenAPI client (https://redx.com.bd/developer-api/).
// Auth: header "API-ACCESS-TOKEN: Bearer <token>". Base URL (sandbox or
// production, e.g. https://openapi.redx.com.bd/v1.0.0-beta) comes from the
// courier settings.

export interface RedxCreds { base_url: string; token: string }

export class RedxError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function call<T>(c: RedxCreds, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${c.base_url}${path}`, {
    method,
    headers: {
      "API-ACCESS-TOKEN": `Bearer ${c.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const d = data as { message?: string; error?: string; errors?: unknown; validation_errors?: unknown } | null;
    const detail = d?.message ?? d?.error ?? (d?.errors ? JSON.stringify(d.errors) : null)
      ?? (d?.validation_errors ? JSON.stringify(d.validation_errors) : null) ?? text.slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new RedxError(`RedX rejected the API token (${res.status}). Check it in Courier settings.`, res.status);
    throw new RedxError(`RedX error ${res.status}: ${detail || res.statusText}`, res.status);
  }
  return data as T;
}

export interface RedxArea { id: number; name: string; post_code?: number | string | null; division_name?: string | null; district_name?: string | null; zone_id?: number | null }
export interface RedxStore { id: number; name: string; address?: string; area_name?: string; area_id?: number; phone?: string }

export const redx = {
  areas: (c: RedxCreds) => call<{ areas: RedxArea[] }>(c, "GET", "/areas").then((r) => r.areas ?? []),
  stores: (c: RedxCreds) => call<{ pickup_stores: RedxStore[] }>(c, "GET", "/pickup/stores").then((r) => r.pickup_stores ?? []),
  createStore: async (c: RedxCreds, s: { name: string; phone: string; address: string; area_id: number }) => {
    const r = await call<RedxStore & { pickup_store?: RedxStore }>(c, "POST", "/pickup/store", s);
    const store = r.pickup_store ?? r;
    if (!store?.id) throw new RedxError("RedX didn't return a pickup store id", 502);
    return store;
  },
  createParcel: async (c: RedxCreds, p: Record<string, unknown>) => {
    const r = await call<{ tracking_id?: string }>(c, "POST", "/parcel", p);
    if (!r?.tracking_id) throw new RedxError("RedX didn't return a tracking id", 502);
    return r.tracking_id;
  },
  parcelInfo: (c: RedxCreds, trackingId: string) =>
    call<{ parcel: { tracking_id: string; status: string; delivery_type?: string } }>(c, "GET", `/parcel/info/${encodeURIComponent(trackingId)}`).then((r) => r.parcel),
};

/** RedX wants local BD numbers: 01XXXXXXXXX. */
export function bdPhone(raw: string | null | undefined): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("880")) d = d.slice(2);        // 8801XXXXXXXXX -> 01XXXXXXXXX
  if (d.length === 10 && d.startsWith("1")) d = `0${d}`;
  return d;
}
