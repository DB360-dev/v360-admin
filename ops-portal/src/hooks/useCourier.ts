/**
 * Courier integration (KBB, RedX first): settings, delivery areas, parcels,
 * and calls to the `courier` Edge Function (book / refresh / test / sync).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { describeError, describeFunctionError } from "@/lib/errors";
import { ROOT } from "./useData";

export const COURIER = "redx";
export const COURIER_LABEL = "RedX";

/** Defaults shown on first setup. Check them against the RedX merchant panel. */
export const REDX_DEFAULTS = {
  sandbox: "https://sandbox.redx.com.bd/v1.0.0-beta",
  production: "https://openapi.redx.com.bd/v1.0.0-beta",
  tracking: "https://redx.com.bd/track-parcel/?trackingId={tracking}",
};

export interface CourierAccount {
  id: string; courier: string; display_name: string; is_enabled: boolean; environment: "sandbox" | "production";
  base_url: string; tracking_url_template: string; pickup_phone: string | null; pickup_address: string | null;
  pickup_area_id: number | null; pickup_area_name: string | null; default_weight_g: number; updated_at: string;
}
export interface CourierArea { area_id: number; name: string; post_code: string | null; district_name: string | null; division_name: string | null }
export interface CourierAlias { city_key: string; area_id: number; area_name: string }
export interface CourierParcel {
  id: string; order_id: string; courier: string; tracking_id: string; tracking_url: string | null; merchant_invoice_id: string;
  delivery_area_id: number; delivery_area_name: string; store_id: string; cod_amount: number; weight_g: number;
  courier_status: string; delivery_type: string | null; status_message: string | null; status_at: string | null;
  paid_at: string | null; is_active: boolean; booked_at: string;
}
export interface BrandStore { brand_id: string; store_id: string; store_name: string; created_at: string }

const k = (...p: unknown[]) => [...ROOT, "courier", ...p];
const ACCOUNT_COLS = "id, courier, display_name, is_enabled, environment, base_url, tracking_url_template, pickup_phone, pickup_address, pickup_area_id, pickup_area_name, default_weight_g, updated_at";

export function useCourierAccount() {
  return useQuery({
    queryKey: k("account"),
    queryFn: async () => {
      const { data, error } = await supabase.from("courier_accounts").select(ACCOUNT_COLS).eq("courier", COURIER).maybeSingle();
      if (error) throw error;
      return data as CourierAccount | null;
    },
  });
}

/** Token set? + webhook token (managers only). */
export function useCourierSecrets(enabled: boolean) {
  return useQuery({
    queryKey: k("secrets"),
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("courier_account_secrets", { p_courier: COURIER });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as { token_set: boolean; webhook_token: string } | undefined;
      return row ?? { token_set: false, webhook_token: "" };
    },
  });
}

/** All delivery areas (can be a few thousand; paged). */
export function useCourierAreas() {
  return useQuery({
    queryKey: k("areas"),
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const out: CourierArea[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("courier_areas")
          .select("area_id, name, post_code, district_name, division_name").eq("courier", COURIER)
          .order("name").order("area_id").range(from, from + 999);
        if (error) throw error;
        out.push(...((data ?? []) as CourierArea[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    },
  });
}

export function useCourierAliases() {
  return useQuery({
    queryKey: k("aliases"),
    queryFn: async () => {
      const { data, error } = await supabase.from("courier_area_aliases").select("city_key, area_id, area_name").eq("courier", COURIER);
      if (error) throw error;
      return (data ?? []) as CourierAlias[];
    },
  });
}

export function useBrandStores(accountId: string | null | undefined) {
  return useQuery({
    queryKey: k("stores", accountId),
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase.from("courier_brand_stores").select("brand_id, store_id, store_name, created_at").eq("courier_account_id", accountId!);
      if (error) throw error;
      return (data ?? []) as BrandStore[];
    },
  });
}

/** Active parcels for these orders, keyed by order id. */
export function useCourierParcels(orderIds: string[]) {
  const ids = [...new Set(orderIds)].sort();
  return useQuery({
    queryKey: k("parcels", ids),
    enabled: ids.length > 0,
    queryFn: async () => {
      const out = new Map<string, CourierParcel>();
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from("courier_parcels").select("*").in("order_id", ids.slice(i, i + 200)).eq("is_active", true);
        if (error) throw error;
        for (const p of (data ?? []) as CourierParcel[]) out.set(p.order_id, p);
      }
      return out;
    },
  });
}

export const useSaveCourierAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      enabled: boolean; environment: "sandbox" | "production"; baseUrl: string; token: string; trackingTemplate: string;
      pickupPhone: string; pickupAddress: string; pickupAreaId: number | null; pickupAreaName: string;
    }) => {
      const { error } = await supabase.rpc("save_courier_account", {
        p_courier: COURIER, p_is_enabled: v.enabled, p_environment: v.environment, p_base_url: v.baseUrl, p_token: v.token,
        p_tracking_url_template: v.trackingTemplate, p_pickup_phone: v.pickupPhone, p_pickup_address: v.pickupAddress,
        p_pickup_area_id: v.pickupAreaId, p_pickup_area_name: v.pickupAreaName,
      });
      if (error) throw error;
    },
    onSuccess: () => toast.success("Courier settings saved"),
    onSettled: () => qc.invalidateQueries({ queryKey: k() }),
  });
};

export const useRegenerateWebhookToken = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("regenerate_courier_webhook_token", { p_courier: COURIER });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => toast.success("New webhook address created. Paste it into RedX."),
    onError: (e) => toast.error(describeError(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: k("secrets") }),
  });
};

export interface BookResult { order_id: string; order_number?: string; ok: boolean; tracking_id?: string; error?: string }
type CourierReply = { ok?: boolean; message?: string; failed?: string[]; results?: BookResult[] & { tracking_id: string; status?: string; applied?: string; error?: string }[] };

/** Call the courier Edge Function. */
export async function courierCall(body: Record<string, unknown>): Promise<CourierReply> {
  const { data, error } = await supabase.functions.invoke("courier", { body });
  if (error) throw new Error(await describeFunctionError(error));
  return data as CourierReply;
}

export const useCourierAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: courierCall,
    onSettled: () => qc.invalidateQueries({ queryKey: ROOT }),
  });
};

// ---------------------------------------------------------------- area matching

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Best delivery area for an order: a city KBB mapped before, then postal code,
 * then an exact area-name match with the city. Null = KBB picks by hand.
 */
export function matchArea(
  o: { city: string | null; province?: string | null; zip: string | null },
  areas: CourierArea[], aliases: CourierAlias[],
): CourierArea | null {
  const city = norm(o.city);
  const alias = aliases.find((a) => a.city_key === (o.city ?? "").trim().toLowerCase());
  if (alias) return areas.find((a) => a.area_id === alias.area_id) ?? { area_id: alias.area_id, name: alias.area_name, post_code: null, district_name: null, division_name: null };
  const zip = (o.zip ?? "").replace(/\D/g, "");
  if (zip) {
    const byZip = areas.filter((a) => (a.post_code ?? "").replace(/\D/g, "") === zip);
    if (byZip.length === 1) return byZip[0];
    const named = byZip.find((a) => norm(a.name) === city);
    if (named) return named;
    if (byZip.length) return byZip[0];
  }
  if (city) {
    const exact = areas.filter((a) => norm(a.name) === city);
    if (exact.length === 1) return exact[0];
  }
  return null;
}

export const areaLabel = (a: CourierArea) =>
  `${a.name}${a.district_name ? ` — ${a.district_name}` : a.division_name ? ` — ${a.division_name}` : ""}${a.post_code ? ` (${a.post_code})` : ""}`;
