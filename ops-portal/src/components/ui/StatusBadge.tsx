import { GROUP_CLASSES, STATUS, type StatusGroup } from "@/lib/status";
import type { OrderStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: OrderStatus }) {
  const s = STATUS[status];
  return <Pill group={s?.group ?? "closed"} label={s?.label ?? status} />;
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
