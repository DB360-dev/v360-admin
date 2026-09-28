// Server-to-server call to shopify-fulfill (used after a courier moves an
// order to "out for delivery"). Authenticates with the service role key,
// which shopify-fulfill accepts as a trusted internal caller. Never throws.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export async function internalShopifyFulfill(orderId: string): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/shopify-fulfill`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId }),
    });
    if (!res.ok) console.error("shopify-fulfill", res.status, await res.text());
  } catch (e) {
    console.error("shopify-fulfill", e);
  }
}
