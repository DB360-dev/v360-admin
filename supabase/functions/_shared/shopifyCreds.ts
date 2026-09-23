// Shopify app Client ID + Secret, loaded from Supabase Vault (set in the
// Admin panel) with a fallback to the classic Edge Function env secrets.
//
// Vault wins when present so rotating credentials in the panel takes effect
// without redeploying functions.

import { createClient } from "npm:@supabase/supabase-js@2";

export interface ShopifyCreds {
  apiKey: string;
  apiSecret: string;
}

export async function getShopifyCreds(): Promise<ShopifyCreds> {
  const envKey = Deno.env.get("SHOPIFY_API_KEY") ?? "";
  const envSecret = Deno.env.get("SHOPIFY_API_SECRET") ?? "";

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await admin.rpc("get_shopify_app_credentials");
    if (!error && data && typeof data === "object") {
      const d = data as { api_key?: string | null; api_secret?: string | null };
      return {
        apiKey: (d.api_key ?? "").trim() || envKey,
        apiSecret: (d.api_secret ?? "").trim() || envSecret,
      };
    }
    if (error) console.error("get_shopify_app_credentials failed", error);
  } catch (e) {
    console.error("load shopify credentials from vault failed", e);
  }

  return { apiKey: envKey, apiSecret: envSecret };
}
