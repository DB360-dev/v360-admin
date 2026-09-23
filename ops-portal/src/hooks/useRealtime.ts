import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { ROOT } from "./useData";

/** Refresh the panel when anything moves (RLS decides what each role receives). */
export function useOpsRealtime(enabled: boolean) {
  const qc = useQueryClient();
  const timer = useRef<number>();
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => qc.invalidateQueries({ queryKey: ROOT }), 500);
    };
    const ch = supabase.channel("ops-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "shipments" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "inbound_batches" }, refresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "order_events" }, refresh)
      .subscribe();
    return () => { window.clearTimeout(timer.current); void supabase.removeChannel(ch); };
  }, [enabled, qc]);
}
