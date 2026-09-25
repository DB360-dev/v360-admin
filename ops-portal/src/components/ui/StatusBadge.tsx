import { GROUP_CLASSES, RETURNED_DISCREPANCY_LABEL, STATUS, type StatusGroup } from "@/lib/status";
import type { OrderStatus } from "@/lib/types";

export function StatusBadge({ status, discrepancy }: { status: OrderStatus; discrepancy?: boolean }) {
  const s = STATUS[status];
  const label = status === "returned" && discrepancy ? RETURNED_DISCREPANCY_LABEL : s?.label ?? status;
  return <Pill group={s?.group ?? "closed"} label={label} />;
}

export function Pill({ group, label }: { group: StatusGroup; label: string }) {
  const c = GROUP_CLASSES[group];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12.5px] font-medium whitespace-nowrap ${c.bg} ${c.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
      {label}
    </span>
  );
}
