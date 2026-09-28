/**
 * Excel (.xlsx) builder for reports. ExcelJS is loaded on demand so it never
 * weighs down normal page loads.
 *
 * A workbook = a "Summary" sheet (title, filters, key figures, breakdown tables)
 * + one or more data sheets (frozen header, auto-filter, typed columns).
 * Columns / figures marked `money` are dropped when the viewer can't see money.
 */

export type ColType = "text" | "number" | "money" | "date" | "datetime" | "percent" | "days";

export interface Column {
  header: string;
  key: string;
  type?: ColType;
  /** Character width; sensible default per type. */
  width?: number;
  /** Removed when the viewer lacks "See money amounts". */
  money?: boolean;
}

export type Row = Record<string, unknown>;

export interface SheetSpec {
  name: string;
  columns: Column[];
  rows: Row[];
}

export interface Figure {
  label: string;
  value: string | number | null | undefined;
  type?: ColType;
  money?: boolean;
}

export interface WorkbookSpec {
  /** Report title, also the file name. */
  title: string;
  /** e.g. "Date range: 1 Sep – 30 Sep 2026", "Brand: All". */
  filters?: string[];
  /** Key figures shown at the top of the Summary sheet. */
  figures?: Figure[];
  /** Breakdown tables shown under the figures on the Summary sheet. */
  breakdowns?: SheetSpec[];
  /** Data sheets (one row per record). */
  sheets: SheetSpec[];
  /** Optional note shown on the Summary sheet (e.g. "Capped at 100,000 rows"). */
  notes?: string[];
}

const FORMAT: Record<ColType, string | undefined> = {
  text: undefined,
  number: "#,##0",
  money: "#,##0.00",
  date: "dd-mmm-yyyy",
  datetime: "dd-mmm-yyyy hh:mm",
  percent: "0.0%",
  days: "0.0",
};

const WIDTH: Record<ColType, number> = { text: 22, number: 12, money: 14, date: 13, datetime: 18, percent: 11, days: 10 };

/** Excel sheet names: max 31 chars, no []:*?/\ */
function sheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";
  let n = 2;
  let out = base;
  while (used.has(out.toLowerCase())) out = `${base.slice(0, 28)} ${n++}`;
  used.add(out.toLowerCase());
  return out;
}

function cellValue(v: unknown, type: ColType): unknown {
  if (v === null || v === undefined || v === "") return null;
  if (type === "date" || type === "datetime") {
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d;
  }
  if (type === "number" || type === "money" || type === "percent" || type === "days") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const keep = (showMoney: boolean) => <T extends { money?: boolean }>(x: T) => showMoney || !x.money;

/** Build the workbook and trigger a browser download. */
export async function downloadWorkbook(spec: WorkbookSpec, opts: { showMoney: boolean; author?: string }): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = opts.author ?? "Reports";
  wb.created = new Date();
  const used = new Set<string>();
  const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFEFF1F5" } };

  // ---- Summary
  const sum = wb.addWorksheet(sheetName("Summary", used));
  sum.getColumn(1).width = 34;
  sum.getColumn(2).width = 22;
  for (let c = 3; c <= 12; c++) sum.getColumn(c).width = 16;
  sum.addRow([spec.title]).font = { bold: true, size: 15 };
  sum.addRow([`Generated ${new Date().toLocaleString()}`]).font = { color: { argb: "FF6B7280" } };
  for (const f of spec.filters ?? []) sum.addRow([f]).font = { color: { argb: "FF6B7280" } };
  for (const n of spec.notes ?? []) sum.addRow([n]).font = { italic: true, color: { argb: "FF6B7280" } };

  const figures = (spec.figures ?? []).filter(keep(opts.showMoney));
  if (figures.length) {
    sum.addRow([]);
    const h = sum.addRow(["Key figures"]);
    h.font = { bold: true };
    for (const f of figures) {
      const type = f.type ?? (typeof f.value === "number" ? "number" : "text");
      const r = sum.addRow([f.label, cellValue(f.value, type)]);
      const fmt = FORMAT[type];
      if (fmt) r.getCell(2).numFmt = fmt;
      r.getCell(2).alignment = { horizontal: "right" };
    }
  }

  for (const b of spec.breakdowns ?? []) {
    const cols = b.columns.filter(keep(opts.showMoney));
    sum.addRow([]);
    sum.addRow([b.name]).font = { bold: true };
    const hr = sum.addRow(cols.map((c) => c.header));
    hr.font = { bold: true };
    hr.eachCell((c) => { c.fill = headerFill; });
    for (const row of b.rows) {
      const r = sum.addRow(cols.map((c) => cellValue(row[c.key], c.type ?? "text")));
      cols.forEach((c, i) => { const fmt = FORMAT[c.type ?? "text"]; if (fmt) r.getCell(i + 1).numFmt = fmt; });
    }
  }

  // ---- Data sheets
  for (const s of spec.sheets) {
    const cols = s.columns.filter(keep(opts.showMoney));
    const ws = wb.addWorksheet(sheetName(s.name, used), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = cols.map((c) => ({
      header: c.header, key: c.key, width: c.width ?? WIDTH[c.type ?? "text"],
      style: FORMAT[c.type ?? "text"] ? { numFmt: FORMAT[c.type ?? "text"] } : {},
    }));
    const hr = ws.getRow(1);
    hr.font = { bold: true };
    hr.eachCell((c) => { c.fill = headerFill; });
    for (const row of s.rows) {
      const out: Row = {};
      for (const c of cols) out[c.key] = cellValue(row[c.key], c.type ?? "text");
      ws.addRow(out);
    }
    if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, s.rows.length + 1), column: cols.length } };
    if (!s.rows.length) ws.addRow({ [cols[0]?.key ?? "a"]: "No data for these filters" });
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${spec.title.replace(/[^\w\- ]+/g, "").trim() || "report"} ${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
