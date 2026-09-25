// Starts the Shopify connection for a brand.
// Called by the Brand Portal (signed-in brand owner) with { brand_id, shop }.
// Returns { url } — the Shopify page where the merchant approves the app.
//
// Secrets: SHOPIFY_API_KEY (client id), optional SHOPIFY_SCOPES (default: read/write orders + write fulfillments),
//          optional ALLOWED_ORIGINS. SUPABASE_* are provided automatically.
//          Client ID is read from Vault (Admin panel) first, then env.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getShopifyCreds } from "../_shared/shopifyCreds.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SCOPES = Deno.env.get("SHOPIFY_SCOPES") ??
  "read_orders,write_orders,write_merchant_managed_fulfillment_orders,write_assigned_fulfillment_orders,write_third_party_fulfillment_orders";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function normalizeShop(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s.endsWith(".myshopify.com")) s = `${s}.myshopify.com`;
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  const { apiKey: SHOPIFY_API_KEY } = await getShopifyCreds();
  if (!SHOPIFY_API_KEY) {
    return json(req, { error: "Shopify connections aren't available yet. Please contact support." }, 500);
  }

  let body: { brand_id?: string; shop?: string };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Invalid request" }, 400);
  }
  if (!body.brand_id || !body.shop) return json(req, { error: "Brand and store address are required" }, 400);

  const shop = normalizeShop(body.shop);
  if (!SHOP_RE.test(shop)) {
    return json(req, { error: "Enter your store's myshopify address, e.g. yourbrand.myshopify.com" }, 400);
  }

  // Act as the calling user so RLS/role checks apply.
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData.user) return json(req, { error: "Your session has expired. Please sign in again." }, 401);

  const [{ data: role }, { data: isV360 }] = await Promise.all([
    asUser.rpc("my_role_in", { p_org_id: body.brand_id }),
    asUser.rpc("is_v360"),
  ]);
  if (role !== "brand_owner" && !isV360) {
    return json(req, { error: "Only the brand owner can connect a Shopify store" }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: taken } = await admin
    .from("shopify_connections").select("brand_id").eq("shop_domain", shop).neq("brand_id", body.brand_id).maybeSingle();
  if (taken) return json(req, { error: "This Shopify store is already connected to another brand" }, 409);

  const state = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  const { error: stateErr } = await admin.from("shopify_oauth_states").insert({
    state, brand_id: body.brand_id, shop_domain: shop, user_id: userData.user.id,
  });
  if (stateErr) {
    console.error(stateErr);
    return json(req, { error: "Could not start the connection. Please try again." }, 500);
  }

  const redirectUri = `${SUPABASE_URL}/functions/v1/shopify-callback`;
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", SHOPIFY_API_KEY);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return json(req, { url: url.toString() });
});
