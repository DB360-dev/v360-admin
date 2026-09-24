import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { describeError, describeFunctionError } from "@/lib/errors";
import type {
  BrandMoneySettings, BrandPayable, BrandRow, FxRate, InboundBatchAdmin, KbbOrderAccount, KbbPayment, MoneySettings, OpsOrderDetail, Order,
  OrderEvent, OrderItem, OrderMessage, OrderOverview, OrderStatus, ReturnDispositionValue, Settlement, ShipmentBrandWeight,
  ShipmentEvent, ShipmentOverview, ShipmentStatus, StatusTransition, TeamMember, WebhookEvent,
} from "@/lib/types";

export const PAGE_SIZE = 50;
export const ROOT = ["ops"] as const;
const k = (...parts: unknown[]) => [...ROOT, ...parts];

// ---------------------------------------------------------------- queries

export function useStatusCounts() {
  return useQuery({
    queryKey: k("counts"),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("ops_order_counts");
      if (error) throw error;
      const map = {} as Partial<Record<OrderStatus, number>>;
      for (const r of (data ?? []) as { status: OrderStatus; count: number }[]) map[r.status] = Number(r.count);
      return map;
    },
  });
}

export interface OrderQuery {
  statuses: OrderStatus[] | null; brandId?: string; search?: string; from?: string; to?: string;
  page?: number; oldestFirst?: boolean; shipmentId?: string; limit?: number;
}
const cleanSearch = (s: string) => s.replace(/[,()*%\\:"']/g, " ").trim();

export function useOrderList(f: OrderQuery) {
  return useQuery({
    queryKey: k("orders", f),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase.from("order_overview").select("*", { count: "exact" });
      if (f.statuses) q = q.in("status", f.statuses);
      if (f.brandId) q = q.eq("brand_id", f.brandId);
      if (f.shipmentId) q = q.eq("shipment_id", f.shipmentId);
      const s = cleanSearch(f.search ?? "");
      if (s) q = q.or(`order_number.ilike.*${s}*,customer_name.ilike.*${s}*,customer_phone.ilike.*${s}*,city.ilike.*${s}*,brand_name.ilike.*${s}*`);
      if (f.from) q = q.gte("order_date", f.from);
      if (f.to) q = q.lt("order_date", new Date(new Date(f.to).getTime() + 86400000).toISOString());
      const size = f.limit ?? PAGE_SIZE;
      const start = (f.page ?? 0) * size;
      q = f.oldestFirst ? q.order("status_changed_at", { ascending: true }) : q.order("order_date", { ascending: false });
      const { data, error, count } = await q.range(start, start + size - 1);
      if (error) throw error;
      return { rows: (data ?? []) as OrderOverview[], total: count ?? 0 };
    },
  });
}

export function useOrder(id: string) {
  return useQuery({
    queryKey: k("order", id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("*, brand:organizations(name), order_items(*), inbound_batch:inbound_batches(*), shipment:shipments(id, code, shipping_partner, tracking_number, origin, destination, status, dispatched_at, received_at)")
        .eq("id", id).maybeSingle();
      if (error) throw error;
      if (data) (data as OpsOrderDetail).order_items.sort((a: OrderItem, b: OrderItem) => a.product_name.localeCompare(b.product_name));
      return data as OpsOrderDetail | null;
    },
  });
}

export function useOrderEvents(orderId: string) {
  return useQuery({
    queryKey: k("events", orderId),
    queryFn: async () => {
      const { data, error } = await supabase.from("order_events").select("*").eq("order_id", orderId).order("id", { ascending: false });
      if (error) throw error;
      return (data ?? []) as OrderEvent[];
    },
  });
}

export function useRecentActivity(limit = 15) {
  return useQuery({
    queryKey: k("activity", limit),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("order_events").select("*, order:orders(order_number)").order("id", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []) as (OrderEvent & { order: { order_number: string } | null })[];
    },
  });
}

export function useTransitions() {
  return useQuery({
    queryKey: k("transitions"),
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from("status_transitions").select("*");
      if (error) throw error;
      return (data ?? []) as StatusTransition[];
    },
  });
}

export function useBrandOptions() {
  return useQuery({
    queryKey: k("brand-options"),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("organizations").select("id, name").eq("type", "brand").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });
}

export function useBrands() {
  return useQuery({
    queryKey: k("brands"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("id, name, type, slug, is_active, approval_status, review_note, created_at, contact_phone, reviewed_at, shopify_connections(shop_domain, status, last_synced_at)")
        .eq("type", "brand").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as BrandRow[];
    },
  });
}

export function useOrganizations() {
  return useQuery({
    queryKey: k("orgs"),
    queryFn: async () => {
      const { data, error } = await supabase.from("organizations").select("id, name, type, is_active").order("type").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; type: "v360" | "partner" | "brand"; is_active: boolean }[];
    },
  });
}

export function useInboundBatches(status: "open" | "all") {
  return useQuery({
    queryKey: k("inbound", status),
    queryFn: async () => {
      let q = supabase.from("inbound_batch_overview").select("*");
      if (status === "open") q = q.in("status", ["in_transit", "issue"]);
      const { data, error } = await q.order("dispatch_date", { ascending: true }).limit(300);
      if (error) throw error;
      return (data ?? []) as InboundBatchAdmin[];
    },
  });
}

export type OrderWithItems = Order & { order_items: OrderItem[] };

export function useBatchOrders(batchId: string | null) {
  return useQuery({
    queryKey: k("batch-orders", batchId),
    enabled: !!batchId,
    queryFn: async () => {
      const { data, error } = await supabase.from("orders").select("*, order_items(*)").eq("inbound_batch_id", batchId!).order("order_number");
      if (error) throw error;
      return (data ?? []) as OrderWithItems[];
    },
  });
}

export function useShipments(scope: "active" | "all") {
  return useQuery({
    queryKey: k("shipments", scope),
    queryFn: async () => {
      let q = supabase.from("shipment_overview").select("*");
      if (scope === "active") q = q.neq("status", "received_by_partner");
      const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as ShipmentOverview[];
    },
  });
}

export function useShipment(id: string) {
  return useQuery({
    queryKey: k("shipment", id),
    queryFn: async () => {
      const { data, error } = await supabase.from("shipment_overview").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data as ShipmentOverview | null;
    },
  });
}

export function useShipmentEvents(id: string) {
  return useQuery({
    queryKey: k("shipment-events", id),
    queryFn: async () => {
      const { data, error } = await supabase.from("shipment_events").select("*").eq("shipment_id", id).order("id", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ShipmentEvent[];
    },
  });
}

export function useTeam() {
  return useQuery({
    queryKey: k("team"),
    queryFn: async () => {
      const { data, error } = await supabase.from("team_members").select("*").order("organization_type").order("organization_name");
      if (error) throw error;
      return (data ?? []) as TeamMember[];
    },
  });
}

export function useFxRates() {
  return useQuery({
    queryKey: k("fx"),
    queryFn: async () => {
      const { data, error } = await supabase.from("fx_rates").select("*").order("rate_date", { ascending: false }).order("id", { ascending: false }).limit(120);
      if (error) throw error;
      return (data ?? []) as FxRate[];
    },
  });
}

export function useWebhooks(onlyFailed: boolean) {
  return useQuery({
    queryKey: k("webhooks", onlyFailed),
    queryFn: async () => {
      let q = supabase.from("webhook_events").select("id, webhook_id, topic, shop_domain, received_at, processed_at, error");
      if (onlyFailed) q = q.not("error", "is", null);
      const { data, error } = await q.order("id", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as WebhookEvent[];
    },
  });
}

/** Whether Shopify Client ID / Secret are stored in Vault — never the values. */
export interface ShopifyCredentialsStatus {
  client_id_set: boolean;
  secret_set: boolean;
  updated_at: string | null;
}

export function useShopifyCredentialsStatus(enabled = true) {
  return useQuery({
    queryKey: k("shopify-creds-status"),
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("shopify_credentials_status");
      if (error) throw error;
      const row = (data ?? [])[0] as ShopifyCredentialsStatus | undefined;
      return row ?? { client_id_set: false, secret_set: false, updated_at: null };
    },
  });
}

// ---------------------------------------------------------------- money

export function useMoneySettings() {
  return useQuery({
    queryKey: k("money-settings"),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_money_settings");
      if (error) throw error;
      return (data ?? {}) as MoneySettings;
    },
  });
}

export function useBrandPayables() {
  return useQuery({
    queryKey: k("payables"),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("brand_payable_overview");
      if (error) throw error;
      return (data ?? []) as BrandPayable[];
    },
  });
}

export function useSettlements() {
  return useQuery({
    queryKey: k("settlements"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("settlements")
        .select("*, brand:organizations(name), settlement_lines(*)")
        .order("id", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Settlement[];
    },
  });
}

export function useKbbAccount() {
  return useQuery({
    queryKey: k("kbb-account"),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("kbb_account_overview");
      if (error) throw error;
      return (data ?? []) as KbbOrderAccount[];
    },
  });
}

export function useKbbPayments() {
  return useQuery({
    queryKey: k("kbb-payments"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kbb_payments")
        .select("*, shipment:shipments(code), order:orders(order_number)")
        .order("id", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as KbbPayment[];
    },
  });
}

export function useShipmentBrandWeights(shipmentId: string | null) {
  return useQuery({
    queryKey: k("shipment-weights", shipmentId),
    enabled: !!shipmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shipment_brand_weights").select("*").eq("shipment_id", shipmentId!);
      if (error) throw error;
      return (data ?? []) as ShipmentBrandWeight[];
    },
  });
}

export function useShipmentCalculatedWeight(shipmentId: string | null) {
  return useQuery({
    queryKey: k("shipment-calculated-weight", shipmentId),
    enabled: !!shipmentId,
    queryFn: async () => {
      if (!shipmentId) return 0;
      const { data, error } = await supabase
        .from("orders")
        .select("id, order_freight_weights(weight_kg)")
        .eq("shipment_id", shipmentId);
      if (error) throw error;
      const total = (data ?? []).reduce((sum, o) => {
        const fw = Array.isArray(o.order_freight_weights)
          ? o.order_freight_weights[0]
          : (o.order_freight_weights as { weight_kg?: number } | null);
        return sum + (Number(fw?.weight_kg) || 0);
      }, 0);
      return Math.round(total * 100) / 100;
    },
  });
}

// -------------------------------------------------------------- mutations

export interface ActionOptions { inlineErrors?: boolean }

function useOpsAction<TVars, TResult = unknown>(
  fn: (v: TVars) => Promise<TResult>,
  success: string | ((r: TResult, v: TVars) => string),
  opts: ActionOptions = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => { toast.success(typeof success === "string" ? success : success(r, v)); },
    onError: (e) => { if (!opts.inlineErrors) toast.error(describeError(e)); },
    onSettled: () => qc.invalidateQueries({ queryKey: ROOT }),
  });
}

async function rpc<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

const trimOrNull = (s?: string | null) => (s && s.trim() ? s.trim() : null);

export const useChangeStatus = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; to: OrderStatus; note?: string }) => rpc("change_order_status", { p_order_id: v.id, p_to: v.to, p_note: trimOrNull(v.note) }),
  "Status updated", o);

export const useHold = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; reason: string }) => rpc("hold_order", { p_order_id: v.id, p_reason: v.reason.trim() }), "Order put on hold", o);

export const useResume = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; note?: string }) => rpc("resume_order", { p_order_id: v.id, p_note: trimOrNull(v.note) }), "Order resumed", o);

export const useOverride = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; to: OrderStatus; reason: string }) => rpc("admin_override_status", { p_order_id: v.id, p_to: v.to, p_reason: v.reason.trim() }),
  "Status overridden", o);

export const useAddNote = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; note: string }) => rpc("add_order_note", { p_order_id: v.id, p_note: v.note.trim() }), "Note added", o);

export const useUpdateOrderDetails = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; changes: Record<string, string> }) => rpc("brand_update_order", { p_order_id: v.id, p_changes: v.changes }),
  "Order details saved", o);

export const useReceiveOrder = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; weight: number; items: { item_id: string; received_quantity: number }[] | null; note?: string }) =>
    rpc<OrderStatus>("receive_order", { p_order_id: v.id, p_order_weight_kg: v.weight, p_items: v.items, p_note: trimOrNull(v.note) }),
  (r) => (r === "ready_for_shipment" ? "Received in full: ready for shipment" : "Recorded as a mismatch: items missing"), o);

export const useCreateShipment = (o?: ActionOptions) => useOpsAction(
  (v: { partner: string; notes: string }) => rpc<string>("create_shipment", { p_shipping_partner: trimOrNull(v.partner), p_notes: trimOrNull(v.notes) }),
  (_r) => "Shipment created", o);

export const useAddToShipment = (o?: ActionOptions) => useOpsAction(
  (v: { shipmentId: string; orderIds: string[] }) => rpc("add_orders_to_shipment", { p_shipment_id: v.shipmentId, p_order_ids: v.orderIds }),
  (_r, v) => `${v.orderIds.length} order${v.orderIds.length === 1 ? "" : "s"} added to the shipment`, o);

export const useCreateShipmentWithOrders = (o?: ActionOptions) => useOpsAction(
  (v: { orderIds: string[]; partner: string; notes: string }) =>
    rpc<string>("create_shipment_with_orders", {
      p_order_ids: v.orderIds, p_shipping_partner: trimOrNull(v.partner), p_notes: trimOrNull(v.notes),
    }),
  (_r, v) => `Shipment created for ${v.orderIds.length} order${v.orderIds.length === 1 ? "" : "s"}`, o);

export const useRemoveFromShipment = (o?: ActionOptions) => useOpsAction(
  (v: { orderId: string; note?: string }) => rpc("remove_order_from_shipment", { p_order_id: v.orderId, p_note: trimOrNull(v.note) }),
  "Order removed from the shipment", o);

export const useUpdateShipment = (o?: ActionOptions) => useOpsAction(
  async (v: { id: string; shipping_partner: string; tracking_number: string; total_weight_kg: string; notes: string }) => {
    const weight = v.total_weight_kg.trim() ? Number(v.total_weight_kg) : null;
    const { error } = await supabase.from("shipments").update({
      shipping_partner: trimOrNull(v.shipping_partner), tracking_number: trimOrNull(v.tracking_number),
      total_weight_kg: weight, notes: trimOrNull(v.notes),
    }).eq("id", v.id).select("id").single();
    if (error) throw error;
  }, "Shipment details saved", o);

export const useShipmentStatus = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; to: ShipmentStatus; note?: string }) => rpc("set_shipment_status", { p_shipment_id: v.id, p_to: v.to, p_note: trimOrNull(v.note) }),
  "Shipment updated: orders inside updated too", o);

export const useSetTracking = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; courier: string; tracking: string }) => rpc("set_delivery_tracking", { p_order_id: v.id, p_courier: v.courier.trim(), p_tracking_number: v.tracking.trim() }),
  "Delivery tracking saved", o);

export const useMarkDelivered = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; cash: number; note?: string }) => rpc("mark_delivered", { p_order_id: v.id, p_cod_collected: v.cash, p_note: trimOrNull(v.note) }),
  "Marked as delivered", o);

export const useReturnDisposition = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; disposition: ReturnDispositionValue; note?: string }) =>
    rpc("set_return_disposition", { p_order_id: v.id, p_disposition: v.disposition, p_note: trimOrNull(v.note) }),
  "Return decision saved", o);

export interface ApproveBrandParams {
  id: string;
  note?: string;
  kbbCommissionPct?: number;
  v360CommissionPct?: number;
  freightBdtPerKg?: number;
  invoiceCompanyName?: string;
}

export const useApproveBrand = (o?: ActionOptions) => useOpsAction(
  (v: ApproveBrandParams) =>
    rpc("approve_brand", {
      p_org_id: v.id,
      p_note: trimOrNull(v.note),
      p_kbb_commission_pct: v.kbbCommissionPct ?? 8,
      p_v360_commission_pct: v.v360CommissionPct ?? 15,
      p_freight_bdt_per_kg: v.freightBdtPerKg ?? 700,
      p_invoice_company_name: trimOrNull(v.invoiceCompanyName),
    }),
  "Brand approved", o);

export function useBrandMoneySettings(brandId: string | null) {
  return useQuery({
    queryKey: k("brand-money-settings", brandId),
    enabled: !!brandId,
    queryFn: async () => {
      if (!brandId) return null;
      const { data, error } = await supabase.rpc("get_brand_money_settings", { p_brand_id: brandId });
      if (error) throw error;
      const row = (data ?? [])[0] as BrandMoneySettings | undefined;
      return row ?? null;
    },
  });
}

export const useSaveBrandMoneySettings = (o?: ActionOptions) => useOpsAction(
  (v: { brandId: string; kbbPct: number; v360Pct: number; freightRate: number; invoiceCompany: string }) =>
    rpc("save_brand_money_settings", {
      p_brand_id: v.brandId,
      p_kbb_commission_pct: v.kbbPct,
      p_v360_commission_pct: v.v360Pct,
      p_freight_bdt_per_kg: v.freightRate,
      p_invoice_company_name: trimOrNull(v.invoiceCompany),
    }),
  "Brand settings saved", o);

export const useRejectBrand = (o?: ActionOptions) => useOpsAction(
  (v: { id: string; note: string }) => rpc("reject_brand", { p_org_id: v.id, p_note: v.note.trim() }), "Brand rejected", o);

export const useAddFxRate = (o?: ActionOptions) => useOpsAction(
  async (v: { date: string; base: string; quote: string; rate: number; note: string }) => {
    const { error } = await supabase.from("fx_rates").upsert(
      { rate_date: v.date, base: v.base.toUpperCase(), quote: v.quote.toUpperCase(), rate: v.rate, note: trimOrNull(v.note) },
      { onConflict: "rate_date,base,quote" },
    );
    if (error) throw error;
  }, "Rate saved", o);

export const useReplayWebhook = (o?: ActionOptions) => useOpsAction(
  (webhookId: string) => rpc<{ action?: string; reason?: string }>("replay_webhook", { p_webhook_id: webhookId }),
  (r) => (r?.action === "error" ? `Replayed, but it failed again: ${r.reason}` : `Replayed: ${r?.action ?? "done"}`), o);

export const useUpdateMembership = (o?: ActionOptions) => useOpsAction(
  async (v: { membershipId: string; role: string }) => {
    const { error } = await supabase.from("memberships").update({ role: v.role }).eq("id", v.membershipId).select("id").single();
    if (error) throw error;
  }, "Role updated", o);

export const useRemoveMembership = (o?: ActionOptions) => useOpsAction(
  async (membershipId: string) => {
    const { error } = await supabase.from("memberships").delete().eq("id", membershipId).select("id").single();
    if (error) throw error;
  }, "Access removed", o);

export const useAddUser = (o?: ActionOptions) => useOpsAction(
  async (v: { email: string; full_name: string; organization_id: string; role: string; password: string }) => {
    const { data, error } = await supabase.functions.invoke("manage-user", {
      body: { ...v, password: v.password || undefined },
    });
    if (error) throw new Error(await describeFunctionError(error));
    return data as { message: string };
  }, (r) => r.message, o);

/** Save Shopify Client ID and/or Secret into Vault. Blank fields keep the stored value. */
export const useSaveShopifyCredentials = (o?: ActionOptions) => useOpsAction(
  async (v: { apiKey: string; apiSecret: string }) => {
    const { error } = await supabase.rpc("save_shopify_app_credentials", {
      p_api_key: v.apiKey.trim() || null,
      p_api_secret: v.apiSecret.trim() || null,
    });
    if (error) throw error;
  },
  "Shopify credentials saved", o);

export const useUpdateMoneySettings = (o?: ActionOptions) => useOpsAction(
  (v: { kbbPct: number; v360Pct: number; freightRate: number; invoiceCompany: string }) =>
    rpc("update_money_settings", {
      p_kbb_commission_pct: v.kbbPct,
      p_v360_commission_pct: v.v360Pct,
      p_freight_bdt_per_kg: v.freightRate,
      p_invoice_company_name: v.invoiceCompany,
    }),
  "Money settings saved", o);

export const useSetShipmentBrandWeight = (o?: ActionOptions) => useOpsAction(
  (v: { shipmentId: string; brandId: string; weightKg: number | null }) =>
    rpc("set_shipment_brand_weight", { p_shipment_id: v.shipmentId, p_brand_id: v.brandId, p_weight_kg: v.weightKg }),
  (_r, v) => (v.weightKg === null ? "Freight weight cleared" : "Freight weight saved"), o);

export const useSetOrderFreightWeight = (o?: ActionOptions) => useOpsAction(
  (v: { orderId: string; weightKg: number | null }) =>
    rpc("set_order_freight_weight", { p_order_id: v.orderId, p_weight_kg: v.weightKg }),
  "Parcel weight saved", o);

export const useRecordKbbPayment = (o?: ActionOptions) => useOpsAction(
  (v: { kind: string; amount: number; currency: string; paymentDate: string; shipmentId?: string | null; orderId?: string | null; note?: string }) =>
    rpc<number>("record_kbb_payment", {
      p_kind: v.kind, p_amount: v.amount, p_currency: v.currency, p_payment_date: v.paymentDate,
      p_shipment_id: v.shipmentId ?? null, p_order_id: v.orderId ?? null, p_note: trimOrNull(v.note),
    }),
  "Payment recorded", o);

export const useCreateSettlement = (o?: ActionOptions) => useOpsAction(
  (v: { brandId: string; periodStart?: string | null; periodEnd?: string | null }) =>
    rpc<number>("create_brand_settlement", {
      p_brand_id: v.brandId, p_period_start: v.periodStart ?? null, p_period_end: v.periodEnd ?? null,
    }),
  "Statement created", o);

export const useMarkSettlementPaid = (o?: ActionOptions) => useOpsAction(
  (settlementId: number) => rpc("mark_settlement_paid", { p_settlement_id: settlementId }),
  "Statement marked as paid", o);

export type QueueOrder = Order & { brand: { name: string } | null; order_items: OrderItem[] };

/** Full order rows for a work queue, oldest waiting first. */
export function useQueue(statuses: OrderStatus[]) {
  return useQuery({
    queryKey: k("queue", statuses),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders").select("*, brand:organizations(name), order_items(*)")
        .in("status", statuses).order("status_changed_at", { ascending: true }).limit(300);
      if (error) throw error;
      return (data ?? []) as QueueOrder[];
    },
  });
}

/** Orders stuck in one non-final status for longer than `days`. */
export function useAgeing(days: number, statuses?: OrderStatus[]) {
  return useQuery({
    queryKey: k("ageing", days, statuses),
    queryFn: async () => {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      let q = supabase.from("order_overview").select("*").lt("status_changed_at", cutoff)
        .not("status", "in", "(delivered,cancelled,returned)");
      if (statuses) q = q.in("status", statuses);
      const { data, error } = await q.order("status_changed_at", { ascending: true }).limit(10);
      if (error) throw error;
      return (data ?? []) as OrderOverview[];
    },
  });
}

/** Small counts for dashboard tiles. RLS decides what each role can count. */
export function useDashboardCounts(isV360: boolean) {
  return useQuery({
    queryKey: k("dash-counts", isV360),
    queryFn: async () => {
      const head = { count: "exact" as const, head: true };
      const shipmentsMoving = supabase.from("shipments").select("*", head).in("status", ["handed_to_carrier", "in_transit", "customs", "arrived_bd"]);
      if (!isV360) {
        const r = await shipmentsMoving;
        if (r.error) throw r.error;
        return { shipmentsMoving: r.count ?? 0, parcelsAwaiting: 0, pendingBrands: 0, failedWebhooks: 0, draftShipments: 0 };
      }
      const [a, b, c, d, e] = await Promise.all([
        shipmentsMoving,
        supabase.from("inbound_batches").select("*", head).in("status", ["in_transit", "issue"]),
        supabase.from("organizations").select("*", head).eq("type", "brand").eq("approval_status", "pending"),
        supabase.from("webhook_events").select("*", head).not("error", "is", null),
        supabase.from("shipments").select("*", head).in("status", ["draft", "ready_for_dispatch"]),
      ]);
      for (const r of [a, b, c, d, e]) if (r.error) throw r.error;
      return { shipmentsMoving: a.count ?? 0, parcelsAwaiting: b.count ?? 0, pendingBrands: c.count ?? 0, failedWebhooks: d.count ?? 0, draftShipments: e.count ?? 0 };
    },
  });
}

// ------------------------------------------------------------ messaging

export function useOrderMessages(orderId: string) {
  return useQuery({
    queryKey: k("messages", orderId),
    enabled: !!orderId,
    refetchInterval: 10_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("order_messages")
        .select("*")
        .eq("order_id", orderId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as OrderMessage[];
    },
  });
}

export function useSendMessage(o?: ActionOptions) {
  return useOpsAction(
    async (v: { orderId: string; body: string }) => {
      const { error } = await supabase.rpc("send_order_message", { p_order_id: v.orderId, p_body: v.body });
      if (error) throw error;
    },
    "Message sent",
    o,
  );
}

export function useMarkMessagesRead(orderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("mark_messages_read", { p_order_id: orderId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: k("messages", orderId) }),
  });
}
