import { Link } from "react-router-dom";
import type { QueueOrder } from "@/hooks/useData";
import { fmtMoney, since, daysSince } from "@/lib/format";
import { StatusBadge } from "./ui/StatusBadge";
import { OrderActions } from "./OrderActions";
import { ContactLinks } from "@/pages/OrderDetail";

/** One order in a work queue: everything needed to act without opening it. */
export function QueueCard({ o, showItems = true }: { o: QueueOrder; showItems?: boolean }) {
  const waited = daysSince(o.status_changed_at);
  const items = o.order_items.reduce((n, i) => n + i.quantity, 0);
  return (
    <li className="panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <Link to={`/orders/${o.id}`} className="font-semibold hover:underline">{o.order_number}</Link>
        <span className="text-[13px] text-muted">{o.brand?.name}</span>
        <StatusBadge status={o.status} />
        {o.confirmation_attempts > 0 && <span className="text-[12.5px] text-muted">{o.confirmation_attempts} call attempt{o.confirmation_attempts > 1 ? "s" : ""}</span>}
        <span className={`ml-auto text-[12.5px] ${waited > 1 ? "font-semibold text-g-problem" : "text-faint"}`} title="Waiting in this step">waiting {since(o.status_changed_at)}</span>
      </div>
      <div className="grid gap-3 px-4 py-3 text-[13.5px] sm:grid-cols-[1.2fr_1fr_auto]">
        <div>
          <div className="font-medium">{o.customer_name ?? "—"}</div>
          <div className="mt-0.5"><ContactLinks phone={o.customer_phone} /></div>
          <div className="mt-1 text-muted">{[o.address1, o.address2, o.city].filter(Boolean).join(", ")}</div>
          {o.customer_note && <div className="mt-1 text-[13px] text-g-brand">Note: {o.customer_note}</div>}
        </div>
        {showItems ? (
          <ul className="space-y-0.5 text-[13px]">
            {o.order_items.slice(0, 4).map((i) => <li key={i.id}><span className="font-semibold">{i.quantity}×</span> {i.product_name}{i.variant ? `, ${i.variant}` : ""}</li>)}
            {o.order_items.length > 4 && <li className="text-muted">+{o.order_items.length - 4} more lines</li>}
          </ul>
        ) : <div className="text-muted">{items} item{items === 1 ? "" : "s"}{o.delivery_tracking_number ? `, ${o.delivery_courier} ${o.delivery_tracking_number}` : ""}</div>}
        <div className="sm:text-right">
          <div className="text-[12.5px] text-muted">Cash to collect</div>
          <div className="text-[16px] font-semibold">{fmtMoney(o.cod_amount_expected, o.cod_currency ?? "BDT")}</div>
        </div>
      </div>
      <div className="border-t border-line bg-sunken/40 px-4 py-2.5"><OrderActions order={o} compact /></div>
    </li>
  );
}
