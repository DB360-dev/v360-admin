import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Membership, MemberRole } from "@/lib/types";
import { useAuth } from "./AuthContext";

/** The two kinds of people who use this panel. */
export type OpsRole = "v360" | "kbb";

interface OpsCtx {
  role: OpsRole | null;
  memberRole: MemberRole | null;
  orgName: string | null;
  /** V360 admin: can manage users and approve brands. Operators can do everything else. */
  isAdmin: boolean;
  isV360: boolean;
  isKbb: boolean;
  /** Signed in, but only as a brand user. */
  brandOnly: boolean;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

const Ctx = createContext<OpsCtx | null>(null);

export function OpsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["ops-memberships", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("memberships")
        .select("role, organization:organizations(id, name, type, slug, is_active, approval_status, review_note)")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []) as unknown as Membership[];
    },
  });

  const list = (q.data ?? []).filter((m) => m.organization?.is_active);
  const v360 = list.find((m) => m.organization.type === "v360");
  const kbb = list.find((m) => m.organization.type === "partner");
  const pick = v360 ?? kbb ?? null;   // V360 wins if someone somehow has both

  return (
    <Ctx.Provider value={{
      role: v360 ? "v360" : kbb ? "kbb" : null,
      memberRole: pick?.role ?? null,
      orgName: pick?.organization.name ?? null,
      isAdmin: v360?.role === "admin",
      isV360: !!v360,
      isKbb: !v360 && !!kbb,
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
