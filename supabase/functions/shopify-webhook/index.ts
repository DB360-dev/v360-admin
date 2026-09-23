// Supabase Edge Function: receives Shopify webhooks for every connected brand.
// Deploy with:  supabase functions deploy shopify-webhook --no-verify-jwt
// Secrets needed: SHOPIFY_API_SECRET (your Shopify app's client secret),
//                 or the same value saved in the Admin panel (Vault wins).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// All the logic (BD filter, duplicates, cancellations, edits) lives in the
// database function process_shopify_webhook(). This file only verifies the
// request really came from Shopify and passes it on.

import { createClient } from "npm:@supabase/supabase-js@2";
import { getShopifyCreds } from "../_shared/shopifyCreds.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Must read the RAW body before parsing, or the signature won't match.
  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shop = req.headers.get("x-shopify-shop-domain") ?? "";
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? "";

  const { apiSecret: SHOPIFY_SECRET } = await getShopifyCreds();
  if (!SHOPIFY_SECRET || !hmac || !safeEqual(await hmacBase64(SHOPIFY_SECRET, raw), hmac)) {
    return new Response("Invalid signature", { status: 401 });
  }
  if (!webhookId || !topic || !shop) {
    return new Response("Missing Shopify headers", { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { data, error } = await supabase.rpc("process_shopify_webhook", {
    p_webhook_id: webhookId,
    p_topic: topic,
    p_shop_domain: shop,
    p_payload: payload,
  });

  if (error) {
    // Database unreachable etc. — 500 makes Shopify retry later.
    console.error("process_shopify_webhook failed", error);
    return new Response("Temporary error", { status: 500 });
  }

  // Order-level problems are logged in webhook_events (visible to V360 for
  // replay), so we still return 200 to stop Shopify retrying the same bad payload.
  console.log(topic, shop, JSON.stringify(data));
  return new Response("ok", { status: 200 });
});
