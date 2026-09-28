import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import JsBarcode from "jsbarcode";
import { supabase } from "@/lib/supabase";
import { COURIER_LABEL, useCourierAccount, useCourierParcels } from "@/hooks/useCourier";
import { ErrorState, Spinner } from "@/components/ui/States";

interface SlipOrder {
  id: string; order_number: string; customer_name: string | null; customer_phone: string | null;
  address1: string | null; address2: string | null; city: string | null; province: string | null; zip: string | null;
  brand: { name: string } | { name: string }[] | null;
  order_items: { product_name: string; variant: string | null; quantity: number }[];
}

function Barcode({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (ref.current) JsBarcode(ref.current, value, { format: "CODE128", height: 42, width: 1.6, fontSize: 13, margin: 0 });
  }, [value]);
  return <svg ref={ref} />;
}

/**
 * Printable A4 COD slips, 8 per page (2 × 4, each 105 × 74 mm).
 * Opened in a new tab from the booking dialog or an order; prints automatically.
 */
export function CourierSlips() {
  const [params] = useSearchParams();
  const ids = useMemo(() => (params.get("orders") ?? "").split(",").filter(Boolean), [params]);
  const acc = useCourierAccount();
  const parcels = useCourierParcels(ids);
  const orders = useQuery({
    queryKey: ["slip-orders", ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("orders")
        .select("id, order_number, customer_name, customer_phone, address1, address2, city, province, zip, brand:organizations(name), order_items(product_name, variant, quantity)")
        .in("id", ids);
      if (error) throw error;
      return (data ?? []) as unknown as SlipOrder[];
    },
  });

  const slips = (orders.data ?? [])
    .map((o) => ({ o, p: parcels.data?.get(o.id) }))
    .filter((x) => x.p)
    .sort((a, b) => a.o.order_number.localeCompare(b.o.order_number, undefined, { numeric: true }));

  const ready = !orders.isLoading && !parcels.isLoading && slips.length > 0;
  useEffect(() => { if (ready) { const t = setTimeout(() => window.print(), 400); return () => clearTimeout(t); } }, [ready]);

  if (!ids.length) return <ErrorState error={new Error("No orders chosen")} />;
  if (orders.isLoading || parcels.isLoading || acc.isLoading) return <Spinner label="Preparing slips" />;
  if (orders.isError) return <ErrorState error={orders.error} />;
  if (!slips.length) return <ErrorState error={new Error(`None of these orders is booked with ${COURIER_LABEL}`)} />;

  return (
    <div className="slips">
      <style>{`
        @page { size: A4; margin: 0; }
        body { background: #fff !important; }
        .slips { display: grid; grid-template-columns: 105mm 105mm; grid-auto-rows: 74mm; width: 210mm; margin: 0 auto; color: #000; }
        .slip { box-sizing: border-box; padding: 4mm 5mm; border: 0.2mm dashed #999; overflow: hidden; font: 9.5pt/1.25 system-ui, sans-serif; display: flex; flex-direction: column; gap: 1.2mm; }
        .slip svg { max-width: 100%; height: auto; }
        .row { display: flex; justify-content: space-between; gap: 3mm; }
        .cod { font-size: 15pt; font-weight: 800; }
        .muted { color: #444; font-size: 8pt; }
        .strong { font-weight: 700; }
        .clip { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        @media screen { .slips { margin: 16px auto; box-shadow: 0 0 0 1px #ddd; } }
        @media print { .slip { break-inside: avoid; } }
      `}</style>
      {slips.map(({ o, p }) => {
        const brand = Array.isArray(o.brand) ? o.brand[0]?.name : o.brand?.name;
        const address = [o.address1, o.address2, o.city, o.province, o.zip].filter(Boolean).join(", ");
        const items = o.order_items.map((i) => `${i.quantity}× ${i.product_name}${i.variant ? ` (${i.variant})` : ""}`).join(", ");
        return (
          <div className="slip" key={o.id}>
            <div className="row">
              <div><div className="strong">{brand ?? "—"}</div><div className="muted">{acc.data?.pickup_phone ?? ""}</div></div>
              <div style={{ textAlign: "right" }}><div className="strong">{COURIER_LABEL}</div><div className="muted">{p!.delivery_area_name}</div></div>
            </div>
            <Barcode value={p!.tracking_id} />
            <div className="row">
              <div>
                <div className="muted">Cash to collect</div>
                <div className="cod">৳ {Number(p!.cod_amount).toLocaleString()}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="muted">Order</div>
                <div className="strong">{o.order_number}</div>
                <div className="muted">{(p!.weight_g / 1000).toFixed(1)} kg · {new Date(p!.booked_at).toLocaleDateString()}</div>
              </div>
            </div>
            <div><span className="strong">{o.customer_name}</span> · {o.customer_phone}</div>
            <div className="clip">{address}</div>
            <div className="muted clip">{items}</div>
          </div>
        );
      })}
    </div>
  );
}
