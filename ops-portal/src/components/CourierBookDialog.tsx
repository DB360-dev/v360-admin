import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import type { QueueOrder } from "@/hooks/useData";
import {
  COURIER_LABEL, areaLabel, matchArea, useCourierAccount, useCourierAction, useCourierAliases, useCourierAreas,
  type BookResult, type CourierArea,
} from "@/hooks/useCourier";
import { describeError } from "@/lib/errors";
import { fmtMoney } from "@/lib/format";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/States";

/** Type-ahead area picker over the courier's area list. */
export function AreaPicker({ areas, value, onChange, id }: {
  areas: CourierArea[]; value: CourierArea | null; onChange: (a: CourierArea | null) => void; id: string;
}) {
  const [text, setText] = useState(value ? areaLabel(value) : "");
  useEffect(() => { setText(value ? areaLabel(value) : ""); }, [value?.area_id]); // eslint-disable-line
  const byLabel = useMemo(() => new Map(areas.map((a) => [areaLabel(a), a])), [areas]);
  return (
    <>
      <input className={`input h-8 ${value ? "" : "border-g-problem"}`} list={id} value={text} placeholder="Type to find the area…"
        aria-label="Delivery area"
        onChange={(e) => { setText(e.target.value); onChange(byLabel.get(e.target.value) ?? null); }} />
      <datalist id={id}>{areas.map((a) => <option key={a.area_id} value={areaLabel(a)} />)}</datalist>
    </>
  );
}

/** Opens the printable A4 COD slips for these orders in a new tab. */
export function printSlips(orderIds: string[]) {
  window.open(`/courier-slips?orders=${orderIds.join(",")}`, "_blank", "noopener");
}

export function CourierBookDialog({ orders: initial, onClose }: { orders: QueueOrder[]; onClose: () => void }) {
  const [orders, setOrders] = useState(initial);
  const acc = useCourierAccount();
  const areas = useCourierAreas();
  const aliases = useCourierAliases();
  const book = useCourierAction();
  const [picked, setPicked] = useState<Record<string, CourierArea | null>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [results, setResults] = useState<BookResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Suggest an area for each order once areas are loaded.
  useEffect(() => {
    if (!areas.data || !aliases.data) return;
    setPicked((cur) => {
      const next = { ...cur };
      for (const o of orders) if (!(o.id in next)) next[o.id] = matchArea(o, areas.data!, aliases.data!);
      return next;
    });
  }, [areas.data, aliases.data, orders]);

  const loading = acc.isLoading || areas.isLoading || aliases.isLoading;
  const notReady = !acc.data?.is_enabled
    ? `${COURIER_LABEL} is turned off. A KBB admin can turn it on in Courier settings.`
    : !areas.data?.length ? `${COURIER_LABEL} delivery areas haven't been downloaded yet. Use "Download areas" in Courier settings.` : null;
  const missing = orders.filter((o) => !picked[o.id]).length;
  const booked = results?.filter((r) => r.ok) ?? [];

  const submit = () => {
    if (results) { onClose(); return; }
    if (missing) { setError(`Choose the delivery area for ${missing} order${missing > 1 ? "s" : ""}`); return; }
    setError(null);
    book.mutate({
      action: "book",
      parcels: orders.map((o) => ({ order_id: o.id, area_id: picked[o.id]!.area_id, area_name: picked[o.id]!.name, instruction: notes[o.id] || undefined })),
    }, {
      onSuccess: (r) => setResults(r.results ?? []),
      onError: (e) => setError(describeError(e)),
    });
  };

  return (
    <Dialog open onClose={onClose} onSubmit={submit} width="lg" busy={book.isPending} error={error}
      title={results ? `Booked with ${COURIER_LABEL}` : `Book ${orders.length} order${orders.length > 1 ? "s" : ""} with ${COURIER_LABEL}`}
      description={results ? "Print the COD slips and stick one on each parcel." :
        `Each parcel is booked under its brand's name at ${acc.data?.default_weight_g ?? 500} g. Orders move to "Preparing for delivery" and become "Out for delivery" when the ${COURIER_LABEL} rider picks them up.`}
      footer={results ? <>
        {booked.length > 0 && <Button onClick={() => printSlips(booked.map((r) => r.order_id))}><Printer className="h-4 w-4" /> Print {booked.length} COD slip{booked.length > 1 ? "s" : ""}</Button>}
        <Button type="submit" variant="primary">Done</Button>
      </> : <>
        <Button onClick={onClose} disabled={book.isPending}>Cancel</Button>
        <Button type="submit" variant="primary" loading={book.isPending} disabled={!!notReady || loading}>Book {orders.length} with {COURIER_LABEL}</Button>
      </>}>
      {loading ? <Spinner /> : results ? (
        <ul className="divide-y divide-line text-[13.5px]">
          {results.map((r) => (
            <li key={r.order_id} className="flex items-start gap-3 py-2">
              <span className="w-24 shrink-0 font-semibold">{r.order_number ?? r.order_id.slice(0, 8)}</span>
              {r.ok ? <span className="text-g-done">Booked · {r.tracking_id}</span> : <span className="text-g-problem">{r.error}</span>}
            </li>
          ))}
        </ul>
      ) : notReady ? (
        <p className="rounded border border-g-problem/30 bg-g-problem-bg px-3 py-2 text-[13.5px] text-g-problem">{notReady}</p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full text-[13px]">
            <thead className="table-head"><tr><th>Order</th><th>Customer</th><th className="text-right">COD</th><th className="w-[42%]">{COURIER_LABEL} delivery area</th></tr></thead>
            <tbody className="table-body">
              {orders.map((o) => (
                <tr key={o.id} className="align-top">
                  <td><div className="font-semibold">{o.order_number}</div><div className="text-[12px] text-faint">{o.brand?.name}</div></td>
                  <td><div className="max-w-[180px] truncate">{o.customer_name}</div><div className="text-[12px] text-muted">{o.city}{o.zip ? ` · ${o.zip}` : ""}</div></td>
                  <td className="whitespace-nowrap text-right">
                    {fmtMoney(o.cod_amount_expected, o.cod_currency ?? "BDT")}
                    {orders.length > 1 && <button type="button" className="ml-2 text-[12px] text-faint hover:text-g-problem" aria-label={`Remove ${o.order_number}`}
                      onClick={() => setOrders((l) => l.filter((x) => x.id !== o.id))}>Remove</button>}
                  </td>
                  <td>
                    <AreaPicker id={`areas-${o.id}`} areas={areas.data ?? []} value={picked[o.id] ?? null} onChange={(a) => setPicked((s) => ({ ...s, [o.id]: a }))} />
                    <input className="input mt-1 h-8" placeholder="Note for the rider (optional)" value={notes[o.id] ?? ""} maxLength={250}
                      onChange={(e) => setNotes((s) => ({ ...s, [o.id]: e.target.value }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {missing > 0 && <p className="mt-2 text-[12.5px] text-g-problem">{missing} order{missing > 1 ? "s" : ""} need{missing > 1 ? "" : "s"} an area. Your choice is remembered for that city next time.</p>}
        </div>
      )}
    </Dialog>
  );
}
