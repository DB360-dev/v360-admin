// Shopify redirects the merchant here after they approve the app.
// Verifies the request, exchanges the code for a token, stores it in Vault,
// registers order webhooks, then sends the merchant back to the Brand Portal.
//
// Secrets: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, BRAND_PORTAL_URL (e.g. https://app.yourdomain.com),
//          optional SHOPIFY_API_VERSION (default 2026-01).
//          Client ID + Secret are read from Vault (Admin panel) first, then env.

import { createClient } from "npm:@supabase/supabase-js@2";
import { getShopifyCreds } from "../_shared/shopifyCreds.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_URL = (Deno.env.get("BRAND_PORTAL_URL") ?? "http://localhost:5173").replace(/\/$/, "");
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-01";

const WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "APP_UNINSTALLED"];

function back(result: "connected" | "error", reason?: string): Response {
  const url = new URL(`${PORTAL_URL}/settings`);
  url.searchParams.set("shopify", result);
  if (reason) url.searchParams.set("reason", reason);
  return Response.redirect(url.toString(), 302);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function registerWebhook(shop: string, token: string, topic: string, uri: string) {
  const endpoint = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const call = async (field: "uri" | "callbackUrl") => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
            webhookSubscription { id } userErrors { field message } } }`,
        variables: { topic, sub: { [field]: uri, format: "JSON" } },
      }),
    });
    return await res.json();
  };

  // Newer API versions use `uri`; older ones `callbackUrl`. Try both.
  let result = await call("uri");
  if (result.errors) result = await call("callbackUrl");

  const userErrors = result?.data?.webhookSubscriptionCreate?.userErrors ?? [];
  const alreadyExists = userErrors.some((e: { message: string }) => /already been taken|already exists/i.test(e.message));
  if (result.errors || (userErrors.length && !alreadyExists)) {
    throw new Error(`${topic}: ${JSON.stringify(result.errors ?? userErrors)}`);
  }
}

Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  const shop = params.get("shop") ?? "";
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  const hmac = params.get("hmac") ?? "";

  const { apiKey: API_KEY, apiSecret: API_SECRET } = await getShopifyCreds();
  if (!API_KEY || !API_SECRET) return back("error", "Shopify is not configured on the server");
  if (!shop || !code || !state || !hmac) return back("error", "The Shopify response was incomplete");

  // 1. Verify the request came from Shopify
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  if (!safeEqual(await hmacHex(API_SECRET, message), hmac)) return back("error", "Could not verify the request");

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 2. Match it to the install we started
  const { data: st } = await admin.from("shopify_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st) return back("error", "This connection link has expired. Please try again.");
  await admin.from("shopify_oauth_states").delete().eq("state", state);
  if (st.shop_domain !== shop) return back("error", "Store address did not match");
  if (new Date(st.expires_at) < new Date()) return back("error", "This connection link has expired. Please try again.");

  // 3. Exchange the code for a token
  let token: string, scopes: string;
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: API_KEY, client_secret: API_SECRET, code }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    token = data.access_token;
    scopes = data.scope ?? "";
    if (!token) throw new Error("no token");
  } catch (e) {
    console.error("token exchange failed", e);
    return back("error", "Shopify did not issue an access token. Please try again.");
  }

  // 4. Store it
  const { error: saveErr } = await admin.rpc("save_shopify_connection", {
    p_brand_id: st.brand_id, p_shop_domain: shop, p_access_token: token, p_scopes: scopes,
  });
  if (saveErr) {
    console.error("save failed", saveErr);
    return back("error", saveErr.message);
  }

  // 5. Register webhooks
  const webhookUrl = `${SUPABASE_URL}/functions/v1/shopify-webhook`;
  try {
    for (const topic of WEBHOOK_TOPICS) await registerWebhook(shop, token, topic, webhookUrl);
  } catch (e) {
    console.error("webhook registration failed", e);
    await admin.from("shopify_connections").update({ status: "error" }).eq("brand_id", st.brand_id);
    return back("error", "Connected, but order notifications could not be set up. Please contact support.");
  }

  return back("connected");
});
