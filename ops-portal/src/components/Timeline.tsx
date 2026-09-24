import { STATUS } from "@/lib/status";
import { fmtDateTime } from "@/lib/format";
import type { OrderEvent } from "@/lib/types";

export function Timeline({ events }: { events: OrderEvent[] }) {
  if (events.length === 0) return <p className="text-[13.5px] text-muted">No activity yet.</p>;
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span aria-hidden className={`absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${
            e.action === "Note added" ? "bg-g-brand" : e.to_status ? "bg-primary" : "bg-faint"}`} />
          <div className="text-[13.5px] font-medium">
            {e.action === "Status changed" && e.to_status ? STATUS[e.to_status]?.label ?? e.to_status : e.action}
          </div>
          {e.to_status && e.from_status && (
            <div className="text-[13px] text-muted">From {STATUS[e.from_status]?.label} to {STATUS[e.to_status]?.label}</div>
          )}
          {e.note && <p className="mt-0.5 whitespace-pre-line text-[13.5px] text-ink/85">{e.note}</p>}
          <div className="mt-0.5 text-[12.5px] text-faint">{e.actor_label ?? "System"}, {fmtDateTime(e.created_at)}</div>
        </li>
      ))}
    </ol>
  );
}
