// Courier integration for KBB (RedX first). Called from the ops portal.
// Deploy with:  supabase functions deploy courier
//
// Body: { action, ... }
//   test         – check the token works (managers)
//   sync_areas   – download the courier's delivery areas (managers)
//   sync_stores  – create a pickup store for every brand that has none (managers)
//   book         – book orders: { parcels: [{ order_id, area_id, area_name, instruction? }] }
//   refresh      – re-read status from the courier: { tracking_ids: [...] }
//
// Each brand's parcels are booked under that brand's own pickup store
// (brand name, KBB's address + phone). Weight is always the configured
// default (500 g). Booking moves the order to "Preparing for delivery";
// the courier's own updates move it on (see courier-webhook).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { bdPhone, redx, RedxError, type RedxCreds } from "../_shared/redx.ts";
import { internalShopifyFulfill } from "../_shared/internalShopifyFulfill.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COURIER = "redx";
const LABEL = "RedX";

interface Account {
  id: string; enabled: boolean; base_url: string; token: string; tracking_url_template: string;
  pickup_phone: string | null; pickup_address: string | null; pickup_area_id: number | null; default_weight_g: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function ensureStore(admin: SupabaseClient, acc: Account, creds: RedxCreds, brand: { id: string; name: string }): Promise<string> {
  const { data: existing } = await admin.from("courier_brand_stores").select("store_id")
    .eq("courier_account_id", acc.id).eq("brand_id", brand.id).maybeSingle();
  if (existing?.store_id) return existing.store_id;
  if (!acc.pickup_phone || !acc.pickup_address || !acc.pickup_area_id) {
    throw new Error("Set KBB's pickup phone, address and area in Courier settings first");
  }
  // Reuse a store with this brand's exact name if one already exists at RedX.
  const stores = await redx.stores(creds);
  const found = stores.find((s) => s.name.trim().toLowerCase() === brand.name.trim().toLowerCase());
  const store = found ?? await redx.createStore(creds, {
    name: brand.name, phone: bdPhone(acc.pickup_phone), address: acc.pickup_address, area_id: acc.pickup_area_id,
  });
  await admin.from("courier_brand_stores").upsert({
    courier_account_id: acc.id, brand_id: brand.id, store_id: String(store.id), store_name: store.name,
  });
  return String(store.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  let body: { action?: string; parcels?: { order_id: string; area_id: number; area_name: string; instruction?: string }[]; tracking_ids?: string[] };
  try { body = await req.json(); } catch { return json(req, { error: "Invalid request" }, 400); }

  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: me } = await asUser.auth.getUser();
  if (!me?.user) return json(req, { error: "Your session has expired. Please sign in again." }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: accRaw } = await admin.rpc("get_courier_credentials", { p_courier: COURIER });
  const acc = accRaw as Account | null;
  if (!acc?.token) return json(req, { error: `${LABEL} isn't set up yet. Add the API token in Courier settings.` }, 409);
  const creds: RedxCreds = { base_url: acc.base_url, token: acc.token };

  const action = body.action ?? "";
  const managerOnly = ["test", "sync_areas", "sync_stores"].includes(action);
  if (managerOnly) {
    const { data: ok } = await asUser.rpc("can_manage_couriers");
    if (!ok) return json(req, { error: "Your role can't change courier settings" }, 403);
  } else {
    const [{ data: p }, { data: v }] = await Promise.all([
      asUser.rpc("partner_can", { p_perm: "deliveries.manage" }),
      asUser.rpc("v360_can", { p_perm: "deliveries.manage" }),
    ]);
    if (!p && !v) return json(req, { error: "Your role doesn't allow managing deliveries" }, 403);
  }

  try {
    if (action === "test") {
      const stores = await redx.stores(creds);
      return json(req, { ok: true, message: `Connected to ${LABEL}: ${stores.length} pickup store(s) on the account` });
    }

    if (action === "sync_areas") {
      const areas = await redx.areas(creds);
      const rows = areas.map((a) => ({
        courier: COURIER, area_id: a.id, name: a.name, post_code: a.post_code != null ? String(a.post_code) : null,
        district_name: a.district_name ?? null, division_name: a.division_name ?? null, zone_id: a.zone_id ?? null,
        synced_at: new Date().toISOString(),
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await admin.from("courier_areas").upsert(rows.slice(i, i + 500));
        if (error) throw error;
      }
      return json(req, { ok: true, message: `${rows.length} ${LABEL} delivery areas downloaded` });
    }

    if (action === "sync_stores") {
      const { data: brands } = await admin.from("organizations").select("id, name").eq("type", "brand").eq("is_active", true).order("name");
      const done: string[] = [];
      const failed: string[] = [];
      for (const b of brands ?? []) {
        try { await ensureStore(admin, acc, creds, b); done.push(b.name); }
        catch (e) { failed.push(`${b.name}: ${message(e)}`); }
      }
      return json(req, { ok: failed.length === 0, message: `${done.length} brand pickup store(s) ready`, failed });
    }

    if (action === "book") {
      if (!acc.enabled) return json(req, { error: `${LABEL} is turned off in Courier settings` }, 409);
      const parcels = body.parcels ?? [];
      if (!parcels.length) return json(req, { error: "Choose at least one order" }, 400);
      const { data: profile } = await admin.from("profiles").select("full_name, email").eq("id", me.user.id).maybeSingle();
      const actor = profile?.full_name || profile?.email || "KBB";

      const results: { order_id: string; order_number?: string; ok: boolean; tracking_id?: string; error?: string }[] = [];
      for (const p of parcels) {
        const { data: o } = await admin.from("orders")
          .select("id, order_number, status, brand_id, customer_name, customer_phone, address1, address2, city, province, zip, cod_amount_expected, customer_note, brand:organizations(id, name)")
          .eq("id", p.order_id).maybeSingle();
        if (!o) { results.push({ order_id: p.order_id, ok: false, error: "Order not found" }); continue; }
        try {
          if (!["received_by_partner", "preparing_for_delivery"].includes(o.status)) {
            throw new Error(`Order is "${o.status}", only orders received by KBB can be booked`);
          }
          const { data: active } = await admin.from("courier_parcels").select("tracking_id").eq("order_id", o.id).eq("is_active", true).maybeSingle();
          if (active) throw new Error(`Already booked (${active.tracking_id})`);
          if (!p.area_id || !p.area_name) throw new Error("Choose the delivery area");
          const phone = bdPhone(o.customer_phone);
          if (phone.length !== 11) throw new Error(`Customer phone "${o.customer_phone ?? ""}" isn't a valid Bangladesh mobile number`);
          const brand = Array.isArray(o.brand) ? o.brand[0] : o.brand;
          const storeId = await ensureStore(admin, acc, creds, { id: o.brand_id, name: brand?.name ?? "Brand" });

          const cod = Math.max(0, Math.round(Number(o.cod_amount_expected ?? 0)));
          const address = [o.address1, o.address2, o.city, o.province, o.zip].filter(Boolean).join(", ");
          const trackingId = await redx.createParcel(creds, {
            customer_name: o.customer_name ?? "Customer",
            customer_phone: phone,
            delivery_area: p.area_name,
            delivery_area_id: p.area_id,
            customer_address: address || (o.city ?? ""),
            merchant_invoice_id: o.order_number,
            cash_collection_amount: String(cod),
            parcel_weight: String(acc.default_weight_g),   // always the default, per business rule
            instruction: (p.instruction ?? o.customer_note ?? "").slice(0, 250),
            value: String(cod),
            parcel_details_json: [],
            pickup_store_id: storeId,
          });
          const url = acc.tracking_url_template.replace("{tracking}", encodeURIComponent(trackingId));

          const { error: insErr } = await admin.from("courier_parcels").insert({
            order_id: o.id, courier_account_id: acc.id, courier: COURIER, tracking_id: trackingId, tracking_url: url,
            merchant_invoice_id: o.order_number, delivery_area_id: p.area_id, delivery_area_name: p.area_name,
            store_id: storeId, cod_amount: cod, weight_g: acc.default_weight_g, booked_by: me.user.id,
          });
          if (insErr) throw new Error(`Booked with ${LABEL} (${trackingId}) but not saved here: ${insErr.message}`);
          const { error: recErr } = await admin.rpc("courier_record_booking", {
            p_order_id: o.id, p_courier_name: LABEL, p_tracking: trackingId, p_url: url, p_actor: actor,
          });
          if (recErr) throw new Error(`Booked (${trackingId}) but the order wasn't updated: ${recErr.message}`);
          // Remember this city -> area choice for next time.
          if (o.city) {
            await admin.from("courier_area_aliases").upsert({
              courier: COURIER, city_key: o.city.trim().toLowerCase(), area_id: p.area_id, area_name: p.area_name, updated_at: new Date().toISOString(),
            });
          }
          results.push({ order_id: o.id, order_number: o.order_number, ok: true, tracking_id: trackingId });
        } catch (e) {
          results.push({ order_id: o.id, order_number: o.order_number, ok: false, error: message(e) });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return json(req, { ok: okCount === results.length, message: `${okCount} of ${results.length} booked with ${LABEL}`, results });
    }

    if (action === "refresh") {
      const ids = (body.tracking_ids ?? []).slice(0, 50);
      const results: { tracking_id: string; status?: string; applied?: string; error?: string }[] = [];
      for (const t of ids) {
        try {
          const parcel = await redx.parcelInfo(creds, t);
          const { data: applied, error } = await admin.rpc("courier_apply_status", {
            p_tracking: t, p_status: parcel.status, p_delivery_type: parcel.delivery_type ?? null,
            p_message: `Status checked: ${parcel.status}`, p_payload: parcel,
          });
          if (error) throw error;
          if (applied === "out_for_delivery") {
            const { data: row } = await admin.from("courier_parcels").select("order_id").eq("tracking_id", t).maybeSingle();
            if (row) await internalShopifyFulfill(row.order_id);
          }
          results.push({ tracking_id: t, status: parcel.status, applied: applied as string });
        } catch (e) { results.push({ tracking_id: t, error: message(e) }); }
      }
      return json(req, { ok: true, results });
    }

    return json(req, { error: "Unknown action" }, 400);
  } catch (e) {
    const status = e instanceof RedxError ? (e.status >= 500 ? 502 : 400) : 500;
    console.error(e);
    return json(req, { error: message(e) }, status);
  }
});
