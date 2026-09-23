import { Check } from "lucide-react";
import { JOURNEY, STATUS, journeyIndex } from "@/lib/status";
import type { OrderStatus } from "@/lib/types";

/**
 * The six legs every order travels. The current leg is filled; a problem
 * on the current leg turns it brick red; cancelled orders show greyed out.
 */
export function JourneyRail({ status, previousStatus }: { status: OrderStatus; previousStatus?: OrderStatus | null }) {
  const effective = status === "hold" && previousStatus ? previousStatus : status;
  const current = journeyIndex(effective);
  const cancelled = status === "cancelled";
  const problem = STATUS[status].group === "problem";

  const currentLabel = cancelled ? "Cancelled" : status === "delivered" ? "Delivered" : current >= 0 ? JOURNEY[current].label : STATUS[status].label;

  return (
    <div>
    <ol className="grid grid-cols-6" aria-label="Order journey">
      {JOURNEY.map((leg, i) => {
        const done = !cancelled && (i < current || (status === "delivered" && i === current));
        const here = !cancelled && i === current && status !== "delivered";
        const tone = here ? (problem ? "problem" : "active") : done ? "done" : "todo";
        return (
          <li key={leg.key} className="relative flex flex-col items-center text-center" aria-current={here ? "step" : undefined}>
            {i > 0 && (
              <span aria-hidden className={`absolute right-1/2 top-[11px] h-[2px] w-full ${i <= current && !cancelled ? "bg-primary" : "bg-line"}`} />
            )}
            <span
              aria-hidden
              className={`relative z-10 grid h-6 w-6 place-items-center rounded-full border-2 text-[11px] font-semibold ${
                tone === "done" ? "border-primary bg-primary text-primary-fg"
                : tone === "active" ? "border-primary bg-surface text-primary ring-4 ring-primary/15"
                : tone === "problem" ? "border-g-problem bg-g-problem-bg text-g-problem ring-4 ring-g-problem/15"
                : "border-line bg-surface text-faint"}`}
            >
              {tone === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className={`mt-2 hidden text-[12.5px] leading-tight sm:block ${here ? "font-semibold text-ink" : done ? "text-ink" : "text-faint"}`}>
              {leg.label}
            </span>
          </li>
        );
      })}
    </ol>
    <p className="mt-3 text-center text-[13px] sm:hidden">
      {current >= 0 && !cancelled && <span className="text-muted">Step {current + 1} of {JOURNEY.length}: </span>}
      <span className="font-semibold">{currentLabel}</span>
    </p>
    </div>
  );
}
