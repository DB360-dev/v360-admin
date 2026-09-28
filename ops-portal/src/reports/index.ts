import type { Perm } from "@/lib/permissions";
import type { OpsRole } from "@/context/OpsContext";
import type { ReportDef } from "./types";
import { V360_ORDER_REPORTS } from "./v360Orders";
import { V360_OPS_REPORTS } from "./v360Ops";
import { V360_FINANCE_REPORTS } from "./v360Finance";
import { KBB_REPORTS } from "./kbb";

/** Every report in the ops portal, in display order. */
export const REPORTS: ReportDef[] = [...V360_ORDER_REPORTS, ...V360_OPS_REPORTS, ...V360_FINANCE_REPORTS, ...KBB_REPORTS];

/** Reports this person may open. */
export function reportsFor(role: OpsRole | null, can: (p: Perm) => boolean): ReportDef[] {
  if (!role) return [];
  return REPORTS.filter((r) => r.side === role && can(r.perm) && (r.requires ?? []).every(can));
}
