import type { OrderItem } from "./types";

type QtyFields = Pick<OrderItem, "quantity"> & Partial<Pick<OrderItem, "fulfilment_origin" | "inventory_qty">>;

/** Units of a line fulfilled from the brand's Bangladesh stock (never pass through the hub). */
export const bdQty = (i: QtyFields) =>
  (i.fulfilment_origin ?? "pakistan") === "bangladesh" ? i.quantity : Math.min(i.quantity, Math.max(0, i.inventory_qty ?? 0));

/** Units the Lahore hub should physically receive from Pakistan. */
export const hubQty = (i: QtyFields) => i.quantity - bdQty(i);
