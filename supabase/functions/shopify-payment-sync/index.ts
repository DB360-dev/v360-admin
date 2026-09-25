// Supabase Edge Function: updates the Shopify payment status of every order
// on an invoice once that invoice is marked paid in the ops portal.
//   50% dispatch advance invoice paid -> manual payment of 50% of the order
//                                        total  => Shopify "Partially paid"
//   final settlement invoice paid     -> mark as paid => Shopify "Paid"
//                                        (delivered orders only; returned /
//                                        failed / cancelled orders are skipped)
// Idempotent: orders already at (or past) the target status are skipped.
// Deploy with:  supabase functions deploy shopify-payment-sync
// Needs the store to have granted write_orders — see shopify-install SCOPES.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-01";

type Target = "partially_paid" | "paid";
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
    throw new Error("The store hasn't granted order write access. Reconnect it from the brand portal.");
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
  const label = target === "paid" ? "paid" : "partially paid";

  for (const o of orders) {
    if (o.status === "cancelled") { summary.skipped++; continue; }
    if (target === "paid" && o.status !== "delivered") { summary.skipped++; continue; }
    if (o.shopify_payment_synced === "paid" || o.shopify_payment_synced === target) { summary.already++; continue; }

    try {
      const store = await storeFor(o.brand_id);
      if ("error" in store) throw new Error(store.error);
      const id = `gid://shopify/Order/${o.shopify_order_id}`;
      const q = await gql(store.shop, store.token, `
        query($id: ID!) { order(id: $id) {
          displayFinancialStatus canMarkAsPaid paymentGatewayNames
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalOutstandingSet { shopMoney { amount currencyCode } } } }`, { id });
      const so = q.data?.order;
      if (!so) throw new Error("Order not found in Shopify");
      const fin: string = so.displayFinancialStatus;

      let already = fin === "PAID" || (target === "partially_paid" && fin === "PARTIALLY_PAID");
      if (!already && target === "partially_paid") {
        const total = Number(so.currentTotalPriceSet.shopMoney.amount);
        const outstanding = Number(so.totalOutstandingSet.shopMoney.amount);
        const amount = Math.min(Math.round(total * 50) / 100, outstanding);
        if (amount <= 0) already = true;
        else {
          // Shopify only accepts a manual payment under a payment method enabled
          // on the shop, so use the one the order was placed with (e.g. COD),
          // then fall back to Shopify's default.
          const pay = async (method: string | null) => {
            const r = await gql(store.shop, store.token, `
              mutation($id: ID!, $amount: MoneyInput!, $method: String) {
                orderCreateManualPayment(id: $id, amount: $amount, paymentMethodName: $method) {
                  order { displayFinancialStatus } userErrors { message } } }`,
              { id, method, amount: { amount: amount.toFixed(2), currencyCode: so.currentTotalPriceSet.shopMoney.currencyCode } });
            return userErr(r.data?.orderCreateManualPayment?.userErrors);
          };
          const gateway: string | null = (so.paymentGatewayNames ?? []).find((g: string) => g && g !== "manual") ?? null;
          let e = gateway ? await pay(gateway) : "no gateway";
          if (e) e = await pay(null);
          if (e) {
            throw new Error(/not configured/i.test(e)
              ? `${e} Enable a manual payment method (e.g. Cash on Delivery) in the store's Shopify Settings → Payments.`
              : e);
          }
        }
      } else if (!already) {
        if (!so.canMarkAsPaid) throw new Error(`Shopify can't mark this order as paid (it is ${fin.toLowerCase().replace(/_/g, " ")})`);
        const r = await gql(store.shop, store.token, `
          mutation($input: OrderMarkAsPaidInput!) {
            orderMarkAsPaid(input: $input) { order { displayFinancialStatus } userErrors { message } } }`,
          { input: { id } });
        const e = userErr(r.data?.orderMarkAsPaid?.userErrors);
        if (e) throw new Error(e);
      }

      await record(o, `Shopify marked ${label}`, `Invoice ${number}${already ? " (already in Shopify)" : ""}`, {
        shopify_payment_synced: target, shopify_payment_synced_at: new Date().toISOString(), shopify_payment_error: null,
      });
      if (already) summary.already++; else summary.updated++;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Shopify request failed";
      summary.failed++;
      summary.errors.push({ order_number: o.order_number, message });
      await record(o, "Shopify payment update failed", `Invoice ${number}: ${message}`, { shopify_payment_error: message });
    }
  }

  return json(req, { invoice_number: number, target, ...summary });
});
