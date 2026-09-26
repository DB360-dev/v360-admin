// Shopify helpers shared by the connect / callback functions.

export const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-01";

export const WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "APP_UNINSTALLED"];

// Scopes asked for when we install a brand's own app (legacy install flow). Keep in
// sync with APP_SCOPES in brand-portal/src/pages/Settings.tsx.
export const APP_SCOPES = [
  "write_assigned_fulfillment_orders", "read_customers", "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders", "write_order_edits", "read_order_edits", "read_orders",
  "write_orders", "read_products", "write_third_party_fulfillment_orders",
].join(",");

export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normalizeShop(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s.endsWith(".myshopify.com")) s = `${s}.myshopify.com`;
  return s;
}

export function hasOrderScope(scopes: string): boolean {
  const set = new Set(scopes.split(",").map((s) => s.trim()).filter(Boolean));
  return set.has("read_orders") || set.has("write_orders") || set.has("read_marketplace_orders");
}

export async function registerWebhook(shop: string, token: string, topic: string, uri: string) {
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
