// Supabase Edge Function: tags every order on an invoice in the brand's Shopify
// store once that invoice is marked paid in the ops portal.
//   50% dispatch advance invoice paid -> tag "50% Advance Received"
//   final settlement invoice paid     -> tag "Full Payment Received"
//                                        (delivered orders only; returned /
//                                        failed / cancelled orders are skipped)
// Shopify's payment status is left alone: recording a partial payment through
// the API only works on Shopify Plus stores. tagsAdd keeps the order's
// existing tags. Idempotent: orders that already have the tag are skipped.
// Deploy with:  supabase functions deploy shopify-payment-sync
// Needs the store to have granted write_orders.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-01";

type Target = "partially_paid" | "paid";
const TAG: Record<Target, string> = { partially_paid: "50% Advance Received", paid: "Full Payment Received" };
type Gql = { data?: Record<string, any>; errors?: unknown };
type Store = { shop: string; token: string } | { error: string };
type OrderRow = {
  id: string; brand_id: string; order_number: string; shopify_order_id: number; status: string;
  shopify_payment_synced: Target | null;
};

async function gql(shop: string, token: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Shopify rejected the store's access token. Reconnect the store.");
  if (!res.ok) throw new Error(`Shopify returned ${res.status}`);
  const r = await res.json() as Gql;
  if (JSON.stringify(r.errors ?? "").includes("ACCESS_DENIED")) {
    // Keep Shopify's own wording: it names the scope or permission that is missing.
    console.error("Shopify ACCESS_DENIED", shop, JSON.stringify(r.errors));
    const detail = Array.isArray(r.errors) ? r.errors.map((e: { message?: string }) => e.message).filter(Boolean).join("; ") : "";
    throw new Error(`Shopify denied access${detail ? ` (${detail})` : ""}. Grant the missing access in the store's app, then reconnect it from the brand portal.`);
  }
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r;
}

const userErr = (errs?: { message: string }[]) => (errs && errs.length ? errs.map((e) => e.message).join("; ") : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  let body: { invoice_number?: string };
  try { body = await req.json(); } catch { return json(req, { error: "Invalid request" }, 400); }
  const number = body.invoice_number?.trim();
  if (!number) return json(req, { error: "Invoice is required" }, 400);

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: userData } = await asUser.auth.getUser();
  if (!userData?.user) return json(req, { error: "Your session has expired. Please sign in again." }, 401);
  const { data: isV360 } = await asUser.rpc("is_v360");
  if (!isV360) return json(req, { error: "Only V360 can update Shopify payment status" }, 403);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ---- Resolve the invoice: saved row, or the per-shipment default number.
  const { data: inv } = await admin.from("invoices")
    .select("invoice_type, payment_status, shipment_ids, order_ids").eq("invoice_number", number).maybeSingle();
  const type = inv?.invoice_type ?? (number.startsWith("INV-SETTLE-") ? "final_settlement" : number.startsWith("INV-DISP-") ? "dispatch_advance" : null);
  if (!type) return json(req, { error: `Invoice ${number} not found` }, 404);
  if (type !== "dispatch_advance" && type !== "final_settlement") {
    return json(req, { error: "Only advance and settlement invoices change Shopify payment status" }, 400);
  }
  const target: Target = type === "final_settlement" ? "paid" : "partially_paid";

  let shipmentIds: string[] = inv?.shipment_ids ?? [];
  let paid = inv?.payment_status === "paid";
  if (!inv) {
    const code = number.replace(/^INV-(DISP|SETTLE)-/, "");
    const { data: sh } = await admin.from("shipments").select("id, invoice_payment_status").eq("code", code).maybeSingle();
    if (!sh) return json(req, { error: `Invoice ${number} not found` }, 404);
    shipmentIds = [sh.id];
    paid = sh.invoice_payment_status === "paid";
  }
  if (!paid) return json(req, { error: `Invoice ${number} is not marked paid` }, 409);

  const cols = "id, brand_id, order_number, shopify_order_id, status, shopify_payment_synced";
  let orders: OrderRow[] = [];
  if (inv?.order_ids?.length) {
    const { data } = await admin.from("orders").select(cols).in("id", inv.order_ids);
    orders = (data ?? []) as OrderRow[];
  } else if (shipmentIds.length) {
    const { data } = await admin.from("orders").select(cols).in("shipment_id", shipmentIds);
    orders = (data ?? []) as OrderRow[];
  }

  // ---- Per-brand Shopify store (cached).
  const stores = new Map<string, Store>();
  const storeFor = async (brandId: string): Promise<Store> => {
    if (stores.has(brandId)) return stores.get(brandId)!;
    let s: Store;
    const { data: conn } = await admin.from("shopify_connections").select("shop_domain, status").eq("brand_id", brandId).maybeSingle();
    if (!conn || conn.status !== "active" || !conn.shop_domain) s = { error: "The brand's Shopify store is not connected" };
    else {
      const { data: token } = await admin.rpc("get_shopify_token", { p_brand_id: brandId });
      s = token ? { shop: conn.shop_domain, token: token as string } : { error: "The brand's Shopify connection has no access token. Reconnect the store." };
    }
    stores.set(brandId, s);
    return s;
  };

  const record = async (o: OrderRow, action: string, note: string | null, fields: Record<string, unknown>) => {
    await admin.from("orders").update(fields).eq("id", o.id);
    await admin.from("order_events").insert({ order_id: o.id, actor_label: "Shopify", action, note });
  };

  const summary = { updated: 0, already: 0, skipped: 0, failed: 0, errors: [] as { order_number: string; message: string }[] };
  const label = `tagged "${TAG[target]}"`;

  for (const o of orders) {
    if (o.status === "cancelled") { summary.skipped++; continue; }
    if (target === "paid" && o.status !== "delivered") { summary.skipped++; continue; }
    if (o.shopify_payment_synced === "paid" || o.shopify_payment_synced === target) { summary.already++; continue; }

    try {
      const store = await storeFor(o.brand_id);
      if ("error" in store) throw new Error(store.error);
      const id = `gid://shopify/Order/${o.shopify_order_id}`;
      const q = await gql(store.shop, store.token, `query($id: ID!) { order(id: $id) { tags } }`, { id });
      const so = q.data?.order;
      if (!so) throw new Error("Order not found in Shopify");
      const tag = TAG[target];
      const already = (so.tags as string[]).some((t) => t.toLowerCase() === tag.toLowerCase());
      if (!already) {
        const r = await gql(store.shop, store.token, `
          mutation($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { node { id } userErrors { message } } }`,
          { id, tags: [tag] });
        const e = userErr(r.data?.tagsAdd?.userErrors);
        if (e) throw new Error(e);
      }

      await record(o, `Shopify order ${label}`, `Invoice ${number}${already ? " (already in Shopify)" : ""}`, {
        shopify_payment_synced: target, shopify_payment_synced_at: new Date().toISOString(), shopify_payment_error: null,
      });
      if (already) summary.already++; else summary.updated++;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Shopify request failed";
      summary.failed++;
      summary.errors.push({ order_number: o.order_number, message });
      await record(o, "Shopify payment tag failed", `Invoice ${number}: ${message}`, { shopify_payment_error: message });
    }
  }

  return json(req, { invoice_number: number, target, ...summary });
});
