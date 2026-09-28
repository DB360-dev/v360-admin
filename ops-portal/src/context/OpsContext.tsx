import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Membership, MemberRole } from "@/lib/types";
import { permAppliesTo, type Perm } from "@/lib/permissions";
import { useAuth } from "./AuthContext";

/** Which side of the business a user works for. What they may do comes from their role's permissions. */
export type OpsRole = "v360" | "kbb";

interface OpsCtx {
  role: OpsRole | null;
  memberRole: MemberRole | null;
  /** Custom role name ("Warehouse", "KBB agent"…), or "V360 admin" for built-in admins. */
  roleName: string | null;
  orgName: string | null;
  /** Built-in V360 admin: every permission, manages every company's staff and roles, Shopify credentials. */
  isAdmin: boolean;
  /** Built-in KBB admin: every KBB permission, manages KBB staff and roles. */
  isKbbAdmin: boolean;
  /** Can open Team & access and Roles & permissions (V360 or KBB admin). */
  canManageTeam: boolean;
  /** The organization this user manages when they aren't a V360 admin (their KBB org). */
  orgId: string | null;
  /** Works for V360 (any role). */
  isV360: boolean;
  /** Works for KBB (any role). */
  isKbb: boolean;
  /** Whether the user's role grants this permission. Admins can do everything. */
  can: (perm: Perm) => boolean;
  /** Signed in, but only as a brand user. */
  brandOnly: boolean;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

type MembershipWithRole = Membership & {
  custom_role: { id: string; name: string; role_permissions: { permission: Perm }[] } | null;
};

const Ctx = createContext<OpsCtx | null>(null);

export function OpsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["ops-memberships", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("memberships")
        .select("role, organization:organizations(id, name, type, slug, is_active, approval_status, review_note), custom_role:roles(id, name, role_permissions(permission))")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []) as unknown as MembershipWithRole[];
    },
  });

  const list = (q.data ?? []).filter((m) => m.organization?.is_active);
  const v360 = list.find((m) => m.organization.type === "v360");
  const kbb = list.find((m) => m.organization.type === "partner");
  const pick = v360 ?? kbb ?? null;   // V360 wins if someone somehow has both
  const isAdmin = v360?.role === "admin";
  const isKbbAdmin = !v360 && kbb?.role === "admin";

  const perms = useMemo(
    () => new Set<Perm>((pick?.custom_role?.role_permissions ?? []).map((p) => p.permission)),
    [pick?.custom_role]);
  const side = v360 ? "v360" : kbb ? "kbb" : null;
  // Built-in admins get every permission of THEIR side only: a KBB admin never gets V360-only pages or actions.
  const can = useCallback((perm: Perm) => !!side && permAppliesTo(perm, side) && (isAdmin || isKbbAdmin || perms.has(perm)),
    [side, isAdmin, isKbbAdmin, perms]);

  return (
    <Ctx.Provider value={{
      role: v360 ? "v360" : kbb ? "kbb" : null,
      memberRole: pick?.role ?? null,
      roleName: isAdmin ? "V360 admin" : isKbbAdmin ? "KBB admin" : pick?.custom_role?.name ?? null,
      orgName: pick?.organization.name ?? null,
      orgId: pick?.organization.id ?? null,
      isAdmin,
      isKbbAdmin,
      canManageTeam: isAdmin || isKbbAdmin,
      isV360: !!v360,
      isKbb: !v360 && !!kbb,
      can,
      brandOnly: !pick && list.some((m) => m.organization.type === "brand"),
      loading: q.isLoading,
      error: q.error,
      refetch: () => void q.refetch(),
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useOps() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useOps must be used inside OpsProvider");
  return c;
}
