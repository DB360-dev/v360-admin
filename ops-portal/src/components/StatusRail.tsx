import { Check } from "lucide-react";
import { GROUP_CLASSES, STATUS, type TrackStep } from "@/lib/status";
import { fmtDate } from "@/lib/format";
import type { OrderEvent, OrderStatus } from "@/lib/types";

/**
 * The order-screen tracking bar: shows the FULL status track for the viewer's
 * organisation — every step is visible, with done steps filled in, the current
 * step highlighted and the remainder shown as upcoming. When the order sits in
 * a status that isn't one of the track steps (e.g. hold, hub issue, in transit)
 * an extra "current" chip is appended so the real state is never hidden.
 */
export function StatusRail({ track, status, events }: { track: TrackStep[]; status: OrderStatus; events: OrderEvent[] }) {
  const reachedAt = new Map<OrderStatus, string>();
  const reached: OrderStatus[] = [];
  for (const e of events) {
    if (e.to_status) {
      reachedAt.set(e.to_status, e.created_at);
      const last = reached[reached.length - 1];
      if (!last || last !== e.to_status) reached.push(e.to_status);
    }
  }

  const idx = (s: OrderStatus) => track.findIndex((t) => t.status === s);
  const inTrack = idx(status) >= 0;
  let cur = idx(status);
  if (!inTrack) {
    let furthest = -1;
    for (const s of [...reached, status]) { const i = idx(s); if (i > furthest) furthest = i; }
    cur = Math.max(furthest, 0);
  }

  const currentLabel = inTrack ? track[cur].label : STATUS[status].label;
  const current = inTrack ? status : null;

  return (
    <div>
      <ol className="flex items-start overflow-x-auto pb-1" aria-label="Status tracking">
        {track.map((step, i) => {
          const done = inTrack ? i < cur : i <= cur;
          const here = inTrack && i === cur;
          return (
            <li key={step.status} className="relative flex min-w-[104px] flex-col items-center px-2.5">
              {i > 0 && (
                <span aria-hidden className={`absolute right-1/2 top-[11px] h-[2px] w-full ${done ? "bg-primary" : "bg-line"}`} />
              )}
              <span aria-hidden
                className={`relative z-10 grid h-6 w-6 place-items-center rounded-full border-2 text-[10px] font-semibold ${
                  done ? "border-primary bg-primary text-primary-fg"
                    : here ? "border-primary bg-surface text-primary ring-4 ring-primary/15"
                    : "border-line bg-surface text-faint"}`}>
                {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className={`mt-2 text-center text-[12.5px] leading-tight ${here ? "font-semibold text-ink" : done ? "text-ink/80" : "text-faint"}`}>
                {step.label}
              </span>
              {(here || done) && reachedAt.get(step.status) && <span className="mt-0.5 text-[11px] text-faint">{fmtDate(reachedAt.get(step.status)!)}</span>}
            </li>
          );
        })}

        {!inTrack && (
          <li className="relative flex min-w-[120px] flex-col items-center px-2.5" aria-current="step">
            <span aria-hidden className="absolute right-1/2 top-[11px] h-[2px] w-full bg-primary" />
            <span aria-hidden
              className={`relative z-10 grid h-6 w-6 place-items-center rounded-full border-2 text-[10px] font-semibold ring-4 ${
                STATUS[status].group === "problem"
                  ? "border-g-problem bg-g-problem-bg text-g-problem ring-g-problem/15"
                  : "border-primary bg-surface text-primary ring-primary/15"}`}>
              {track.length + 1}
            </span>
            <span className="mt-2 text-center text-[12.5px] font-semibold leading-tight text-ink">{STATUS[status].label}</span>
            {reachedAt.get(status) && <span className="mt-0.5 text-[11px] text-faint">{fmtDate(reachedAt.get(status)!)}</span>}
          </li>
        )}
      </ol>
      <p className="mt-3 text-center text-[13px] sm:hidden">
        <span className="font-semibold">{currentLabel}</span>
        {current && <span className="text-muted"> — {STATUS[current].label}</span>}
      </p>
      <div className="mt-2 flex justify-end gap-3 text-[11.5px] text-faint">
        <span className="inline-flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${GROUP_CLASSES.done.dot}`} /> done</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" /> current</span>
      </div>
    </div>
  );
}