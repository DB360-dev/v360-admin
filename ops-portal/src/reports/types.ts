import type { Perm } from "@/lib/permissions";
import type { WorkbookSpec } from "@/lib/excel";

/** Filters a report can ask for on the Reports page. */
export type FilterKind = "dateRange" | "brand" | "status" | "shipment" | "asOf";

export interface ReportFilters {
  /** yyyy-mm-dd, inclusive. */
  from: string | null;
  to: string | null;
  brandId: string | null;
  brandName: string | null;
  status: string | null;
  shipmentId: string | null;
  shipmentCode: string | null;
}

export interface ReportContext {
  /** Viewer may see money amounts ("See money amounts"). Money columns are dropped otherwise. */
  showMoney: boolean;
  can: (p: Perm) => boolean;
  /** Viewer's organization name ("V360", "KBB"…). */
  orgName: string | null;
  /** Called with progress text while fetching ("Loading orders 3,000…"). */
  progress: (text: string) => void;
}

export interface ReportDef {
  /** Short code shown on the card, e.g. "V1", "K5". */
  code: string;
  /** Permission that allows this report. */
  perm: Perm;
  /** Which side of the ops portal shows it. */
  side: "v360" | "kbb";
  category: string;
  title: string;
  description: string;
  filters: FilterKind[];
  /** Other permissions needed besides `perm` (e.g. "invoices.view" for finance reports). */
  requires?: Perm[];
  /** Filter that must be filled before download (e.g. a manifest needs a shipment). */
  required?: FilterKind[];
  run: (f: ReportFilters, ctx: ReportContext) => Promise<WorkbookSpec>;
}
