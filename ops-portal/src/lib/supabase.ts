import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Set when env vars are missing, so the app can show a setup screen instead of crashing. */
export const configError: string | null =
  !url || !anonKey
    ? "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing. Copy .env.example to .env and fill them in."
    : null;

export const supabase: SupabaseClient = createClient(
  url ?? "http://localhost:54321",
  anonKey ?? "missing-anon-key",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);
