const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const shortFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

export const fmtDate = (v?: string | null) => (v ? dateFmt.format(new Date(v)) : "—");
export const fmtDateTime = (v?: string | null) => (v ? dateTimeFmt.format(new Date(v)) : "—");
export const fmtShort = (v?: string | null) => (v ? shortFmt.format(new Date(v)) : "—");

export function fmtMoney(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined) return "—";
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: currency || "PKR", currencyDisplay: "code",
      maximumFractionDigits: n % 1 === 0 ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency ?? ""} ${n.toLocaleString("en-US")}`.trim();
  }
}

/** "3h", "2d" — how long something has waited. */
export function since(v?: string | null): string {
  if (!v) return "—";
  const mins = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

export function daysSince(v?: string | null): number {
  return v ? (Date.now() - new Date(v).getTime()) / 86400000 : 0;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export const todayISO = () => new Date().toISOString().slice(0, 10);
