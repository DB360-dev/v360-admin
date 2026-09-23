import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";

interface AuthCtx {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /** True after the user arrived from a password-reset or invite link. */
  recovery: boolean;
  clearRecovery: () => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(() => /type=(recovery|invite)/.test(window.location.hash));

  useEffect(() => {
    let active = true;
    supabase.auth.getSession()
      .then(({ data }) => { if (active) setSession(data.session); })
      .catch(() => { /* treated as signed out */ })
      .finally(() => { if (active) setLoading(false); });

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_OUT") queryClient.clear();
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut().catch(() => undefined);
    setSession(null);
    queryClient.clear();
  };

  return (
    <Ctx.Provider value={{ session, user: session?.user ?? null, loading, recovery, clearRecovery: () => setRecovery(false), signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used inside AuthProvider");
  return c;
}
