// Shopify redirects the merchant here after they approve (install) the app.
// Verifies the request, exchanges the code for a token, stores it in Vault,
// registers order webhooks, then sends the merchant back to the Brand Portal.
//
// Two kinds of install land here:
//   • the brand's OWN app, started by shopify-connect. Its Client ID + secret
//     are parked with the OAuth state (take_shopify_install) and used here.
//   • the old shared app (shopify-install), using sharedCreds().
//
// Secrets: BRAND_PORTAL_URL (e.g. https://app.yourdomain.com), SHOPIFY_API_KEY /
//          SHOPIFY_API_SECRET or the Admin panel (shared app only), optional SHOPIFY_API_VERSION.
// Kept in step with brand repo (v360) supabase/functions/shopify-callback/index.ts.

import { createClient } from "npm:@supabase/supabase-js@2";
import { hasOrderScope, registerWebhook, WEBHOOK_TOPICS } from "../_shared/shopify.ts";
import { getShopifyCreds } from "../_shared/shopifyCreds.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Must be a full address like https://app.yourdomain.com. Anything else falls back to localhost
// (and is logged), instead of crashing the function.
const RAW_PORTAL = (Deno.env.get("BRAND_PORTAL_URL") ?? "").trim().replace(/^["']|["']$/g, "").replace(/\/$/, "");
const PORTAL_URL = /^https?:\/\/[^\s]+$/.test(RAW_PORTAL) ? RAW_PORTAL : "http://localhost:5173";
if (PORTAL_URL !== RAW_PORTAL) console.error(`BRAND_PORTAL_URL is missing or invalid ("${RAW_PORTAL}"). Using ${PORTAL_URL}.`);

/** The old shared app's keys (connections started by shopify-install): Admin panel first, then env. */
const sharedCreds = getShopifyCreds;

function back(result: "connected" | "error", reason?: string): Response {
  if (result === "error") console.error("shopify-callback:", reason);
  try {
    const url = new URL(`${PORTAL_URL}/settings`);
    url.searchParams.set("shopify", result);
    if (reason) url.searchParams.set("reason", reason);
    return new Response(null, { status: 302, headers: { Location: url.toString() } });
  } catch {
    // Last resort: a readable page instead of a blank "Internal Server Error".
    const msg = result === "connected" ? "Shopify connected. You can close this tab and return to the portal." : `Shopify connection failed: ${reason ?? "unknown error"}`;
    return new Response(`<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:2rem">${msg.replace(/</g, "&lt;")}</p>`,
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
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

interface PendingInstall {
  brand_id: string; shop_domain: string; expires_at: string;
  client_id: string | null; client_secret: string | null;
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    console.error("shopify-callback crashed", e);
    return back("error", "Something went wrong while connecting to Shopify. Please try again.");
  }
});

async function handle(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const shop = params.get("shop") ?? "";
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  const hmac = params.get("hmac") ?? "";

  if (shop && hmac && !state) {
    return back("error", "Please start the connection from Settings in the portal, using Connect store.");
  }
  if (!shop || !code || !state || !hmac) return back("error", "The Shopify response was incomplete");

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 1. Match it to the install we started (single use), and pick the app's keys
  const { data: st, error: stErr } = await admin.rpc("take_shopify_install", { p_state: state });
  if (stErr) throw stErr;
  const pending = st as PendingInstall | null;
  if (!pending) return back("error", "This connection link has expired. Please try again.");

  const brandApp = !!(pending.client_id && pending.client_secret);
  const { apiKey, apiSecret } = brandApp
    ? { apiKey: pending.client_id!, apiSecret: pending.client_secret! }
    : await sharedCreds();
  if (!apiKey || !apiSecret) return back("error", "Shopify is not configured on the server");

  // 2. Verify the request came from Shopify, signed with that app's secret
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  if (!safeEqual(await hmacHex(apiSecret, message), hmac)) return back("error", "Could not verify the request");
  if (pending.shop_domain !== shop) return back("error", "Store address did not match");
  if (new Date(pending.expires_at) < new Date()) return back("error", "This connection link has expired. Please try again.");

  // 3. Exchange the code for a token
  let token: string, scopes: string, expiresIn: number | null;
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    token = data.access_token;
    scopes = data.scope ?? "";
    expiresIn = data.expires_in ? Number(data.expires_in) : null;
    if (!token) throw new Error("no token");
  } catch (e) {
    console.error("token exchange failed", e);
    return back("error", "Shopify did not issue an access token. Please try again.");
  }
  console.log("shopify token granted", { shop, scopes, brandApp });

  // 4. Store it
  const { error: saveErr } = brandApp
    ? await admin.rpc("save_shopify_app_connection", {
      p_brand_id: pending.brand_id, p_shop_domain: shop, p_client_id: apiKey, p_client_secret: apiSecret,
      p_access_token: token, p_scopes: scopes, p_expires_in: expiresIn,
    })
    : await admin.rpc("save_shopify_connection", {
      p_brand_id: pending.brand_id, p_shop_domain: shop, p_access_token: token, p_scopes: scopes,
    });
  if (saveErr) {
    console.error("save failed", saveErr);
    return back("error", saveErr.message);
  }

  // 5. Register webhooks. Order topics need read_orders on the app.
  if (!hasOrderScope(scopes)) {
    console.error("missing order scope; cannot register order webhooks", { shop, scopes });
    await admin.from("shopify_connections").update({ status: "error" }).eq("brand_id", pending.brand_id);
    return back("error", "Shopify did not grant order access. Add the read_orders access scope to your app, release a new version, then connect again.");
  }

  const webhookUrl = `${SUPABASE_URL}/functions/v1/shopify-webhook`;
  try {
    for (const topic of WEBHOOK_TOPICS) await registerWebhook(shop, token, topic, webhookUrl);
  } catch (e) {
    console.error("webhook registration failed", e, { shop, scopes });
    await admin.from("shopify_connections").update({ status: "error" }).eq("brand_id", pending.brand_id);
    return back("error", "Connected, but new orders can't be sent to us yet. In your Shopify app, turn on protected customer data access (name, email, phone, address), release a new version, then connect again.");
  }

  return back("connected");
}
