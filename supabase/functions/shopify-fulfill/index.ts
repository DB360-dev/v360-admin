// Supabase Edge Function: marks a Shopify order fulfilled with the KBB
// delivery tracking (courier, number, link) once it's out for delivery.
// Called from the ops portal after "Out for delivery" or a tracking edit.
// Deploy with:  supabase functions deploy shopify-fulfill
//
// * First call creates the fulfillment (customer is notified by Shopify).
// * Later calls update the tracking on that same fulfillment.
// The result (fulfillment id or error) is stored on the order.
// Needs the store to have granted write_merchant_managed_fulfillment_orders
// (plus assigned / third-party variants) — see shopify-install SCOPES.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-01";

const FULFILLABLE = ["OPEN", "IN_PROGRESS"];

type Gql = { data?: Record<string, any>; errors?: unknown };

async function gql(shop: string, token: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Shopify rejected the store's access token. Reconnect the store.");
  if (!res.ok) throw new Error(`Shopify returned ${res.status}`);
  return await res.json();
}

function userErrorText(errs: { message: string }[] | undefined): string | null {
  return errs && errs.length ? errs.map((e) => e.message).join("; ") : null;
}

function accessDenied(r: Gql): boolean {
  return JSON.stringify(r.errors ?? "").includes("ACCESS_DENIED");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  let body: { order_id?: string };
  try { body = await req.json(); } catch { return json(req, { error: "Invalid request" }, 400); }
  if (!body.order_id) return json(req, { error: "Order is required" }, 400);

  // Only V360 and KBB may push fulfillments.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: userData } = await asUser.auth.getUser();
  if (!userData?.user) return json(req, { error: "Your session has expired. Please sign in again." }, 401);
  const [{ data: isV360 }, { data: isPartner }] = await Promise.all([asUser.rpc("is_v360"), asUser.rpc("is_partner")]);
  if (!isV360 && !isPartner) return json(req, { error: "Not allowed" }, 403);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: o, error: oErr } = await admin.from("orders")
    .select("id, brand_id, order_number, shopify_order_id, status, delivery_courier, delivery_tracking_number, delivery_tracking_url, shopify_fulfillment_id")
    .eq("id", body.order_id).maybeSingle();
  if (oErr || !o) return json(req, { error: "Order not found" }, 404);
  if (!o.delivery_tracking_number) return json(req, { error: "Add delivery tracking first" }, 409);
  if (!["out_for_delivery", "delivered", "delivery_failed"].includes(o.status)) {
    return json(req, { skipped: true, reason: "Order is not out for delivery yet" });
  }

  const fail = async (message: string, status = 502) => {
    await admin.from("orders").update({ shopify_fulfillment_error: message }).eq("id", o.id);
    await admin.from("order_events").insert({ order_id: o.id, actor_label: "Shopify", action: "Shopify fulfillment failed", note: message });
    return json(req, { error: message }, status);
  };

  const { data: conn } = await admin.from("shopify_connections").select("shop_domain, status").eq("brand_id", o.brand_id).maybeSingle();
  if (!conn || conn.status !== "active" || !conn.shop_domain) return await fail("The brand's Shopify store is not connected", 409);
  const { data: token } = await admin.rpc("get_shopify_token", { p_brand_id: o.brand_id });
  if (!token) return await fail("The brand's Shopify connection has no access token. Reconnect the store.", 409);

  const trackingInfo = {
    company: o.delivery_courier ?? undefined,
    number: o.delivery_tracking_number,
    ...(o.delivery_tracking_url ? { url: o.delivery_tracking_url } : {}),
  };

  try {
    // Already fulfilled by us: just update the tracking.
    if (o.shopify_fulfillment_id) {
      const r = await gql(conn.shop_domain, token as string, `
        mutation($id: ID!, $t: FulfillmentTrackingInput!) {
          fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $t, notifyCustomer: true) {
            fulfillment { id } userErrors { message } } }`, { id: o.shopify_fulfillment_id, t: trackingInfo });
      if (accessDenied(r)) return await fail("The store hasn't granted fulfillment access. Reconnect it from the brand portal.", 403);
      const err = userErrorText(r.data?.fulfillmentTrackingInfoUpdate?.userErrors) ?? (r.errors ? JSON.stringify(r.errors) : null);
      if (err) return await fail(err);
      await admin.from("orders").update({ shopify_fulfillment_error: null }).eq("id", o.id);
      await admin.from("order_events").insert({ order_id: o.id, actor_label: "Shopify", action: "Shopify tracking updated",
        note: `${o.delivery_courier ?? ""} ${o.delivery_tracking_number}`.trim() });
      return json(req, { updated: true, fulfillment_id: o.shopify_fulfillment_id });
    }

    // Find the open fulfillment orders.
    const q = await gql(conn.shop_domain, token as string, `
      query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status } } } }`,
      { id: `gid://shopify/Order/${o.shopify_order_id}` });
    if (accessDenied(q)) return await fail("The store hasn't granted fulfillment access. Reconnect it from the brand portal.", 403);
    if (q.errors) return await fail(JSON.stringify(q.errors));
    const nodes: { id: string; status: string }[] = q.data?.order?.fulfillmentOrders?.nodes ?? [];
    const open = nodes.filter((n) => FULFILLABLE.includes(n.status));
    if (!open.length) return await fail("Shopify has nothing left to fulfill on this order (already fulfilled or cancelled there).", 409);

    const r = await gql(conn.shop_domain, token as string, `
      mutation($f: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { message } } }`, {
      f: {
        lineItemsByFulfillmentOrder: open.map((n) => ({ fulfillmentOrderId: n.id })),
        trackingInfo,
        notifyCustomer: true,
      },
    });
    if (accessDenied(r)) return await fail("The store hasn't granted fulfillment access. Reconnect it from the brand portal.", 403);
    const err = userErrorText(r.data?.fulfillmentCreate?.userErrors) ?? (r.errors ? JSON.stringify(r.errors) : null);
    const id = r.data?.fulfillmentCreate?.fulfillment?.id;
    if (err || !id) return await fail(err ?? "Shopify did not create the fulfillment");

    await admin.from("orders").update({
      shopify_fulfillment_id: id, shopify_fulfilled_at: new Date().toISOString(), shopify_fulfillment_error: null,
    }).eq("id", o.id);
    await admin.from("order_events").insert({ order_id: o.id, actor_label: "Shopify", action: "Fulfilled in Shopify",
      note: `${o.delivery_courier ?? ""} ${o.delivery_tracking_number}`.trim() });
    return json(req, { fulfilled: true, fulfillment_id: id });
  } catch (e) {
    console.error("shopify-fulfill", e);
    return await fail(e instanceof Error ? e.message : "Shopify request failed");
  }
});
