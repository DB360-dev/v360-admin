// Receives RedX parcel status updates (webhook). Public endpoint — no user
// session — so it's protected by a secret token in the URL:
//   https://<project>.supabase.co/functions/v1/courier-webhook?token=<token>
// The token is shown in the ops portal's Courier settings (KBB admins) and
// must be pasted into RedX's webhook settings.
// Deploy with:  supabase functions deploy courier-webhook --no-verify-jwt
//
// RedX payload: { tracking_number, timestamp, status, message_en, message_bn,
//                 invoice_number, delivery_type }
// What happens is decided in the database (courier_apply_status):
//   delivery-in-progress -> Out for delivery (+ Shopify fulfillment)
//   delivered            -> Delivered, cash collected = booked COD
//   anything else        -> noted on the order's timeline only

import { createClient } from "npm:@supabase/supabase-js@2";
import { internalShopifyFulfill } from "../_shared/internalShopifyFulfill.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time string comparison. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: acc } = await admin.rpc("get_courier_credentials", { p_courier: "redx" });
  const expected = (acc as { webhook_token?: string } | null)?.webhook_token ?? "";
  const given = new URL(req.url).searchParams.get("token") ?? "";
  if (!expected || !same(given, expected)) return reply(401, { error: "Invalid token" });

  let p: Record<string, unknown>;
  try { p = await req.json(); } catch { return reply(400, { error: "Invalid JSON" }); }

  const tracking = String(p.tracking_number ?? p.tracking_id ?? "").trim();
  if (!tracking) return reply(400, { error: "tracking_number is required" });
  const status = p.status != null ? String(p.status) : null;

  const { data: applied, error } = await admin.rpc("courier_apply_status", {
    p_tracking: tracking,
    p_status: status,
    p_delivery_type: p.delivery_type != null ? String(p.delivery_type) : null,
    p_message: (p.message_en as string | undefined) ?? null,
    p_payload: p,
  });
  if (error) {
    console.error("courier_apply_status", error);
    return reply(500, { error: "Could not record the update" });   // RedX will retry
  }

  if (applied === "out_for_delivery") {
    const { data: row } = await admin.from("courier_parcels").select("order_id").eq("tracking_id", tracking).maybeSingle();
    if (row) await internalShopifyFulfill(row.order_id);
  }
  return reply(200, { ok: true, applied });
});
