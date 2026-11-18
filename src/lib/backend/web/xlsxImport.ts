/**
 * Excel import with SheetJS, read entirely in the browser. Type inference, header handling and
 * empty-row rules port `src-tauri/src/import/xlsx.rs` (calamine) so both targets agree.
 */

import type { CellObject, WorkBook } from "xlsx";
import type { Db } from "./db";
import { appError } from "./errors";
import { tableName } from "./ident";
import { csvText, loadTypedCsv, type TypedColumn } from "./typedCsv";
import { formatDate } from "./values";

type ColType = "empty" | "int" | "float" | "bool" | "date" | "timestamp" | "text";

const SQL_TYPE: Record<ColType, string> = {
  int: "BIGINT",
  float: "DOUBLE",
  bool: "BOOLEAN",
  date: "DATE",
  timestamp: "TIMESTAMP",
  empty: "VARCHAR",
  text: "VARCHAR",
};

export function mergeType(a: ColType, b: ColType): ColType {
  if (b === "empty") return a;
  if (a === "empty") return b;
  if (a === b) return a;
  if ((a === "int" && b === "float") || (a === "float" && b === "int")) return "float";
  if ((a === "date" && b === "timestamp") || (a === "timestamp" && b === "date")) return "timestamp";
  return "text";
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Reject files that are not workbooks before SheetJS tries to read them as text. */
function checkSignature(bytes: Uint8Array, name: string) {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const sig = ext === "xls" ? OLE : ZIP;
  if (bytes.length < sig.length || sig.some((b, i) => bytes[i] !== b)) {
    throw appError("unsupportedFile", `${name} is not a valid ${ext === "xls" ? "Excel 97-2003" : "Excel/ODS"} workbook`);
  }
}

async function readWorkbook(bytes: Uint8Array, name: string, opts: Record<string, unknown>): Promise<WorkBook> {
  checkSignature(bytes, name);
  const XLSX = await import("xlsx");
  try {
    return XLSX.read(bytes, { type: "array", ...opts });
  } catch (e) {
    throw appError("unsupportedFile", e instanceof Error ? e.message : String(e));
  }
}

export async function listSheets(bytes: Uint8Array, name: string): Promise<string[]> {
  return (await readWorkbook(bytes, name, { bookSheets: true })).SheetNames;
}

interface Ctx {
  isDate: (fmt: string) => boolean;
  date1904: boolean;
}

/** Excel serial -> epoch ms (calamine semantics, including the 1900 leap-year bug). */
function serialToMs(serial: number, date1904: boolean): number {
  let days = date1904 ? serial + 1462 : serial;
  if (days < 60) days += 1;
  return Math.round((days - 25569) * 86_400_000);
}

function cellDateMs(cell: CellObject, ctx: Ctx): number | null {
  if (cell.t === "d") {
    const d = cell.v instanceof Date ? cell.v : new Date(String(cell.v));
    if (Number.isNaN(d.getTime())) return null;
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  }
  if (cell.t === "n" && typeof cell.v === "number" && cell.z != null && ctx.isDate(String(cell.z))) {
    return serialToMs(cell.v, ctx.date1904);
  }
  return null;
}

const isIntegral = (f: number) => Number.isInteger(f) && Math.abs(f) < 9e15;
const isMidnight = (ms: number) => ms % 86_400_000 === 0;
const pad = (n: number) => String(n).padStart(2, "0");

function timestampText(ms: number, millis: boolean): string {
  const d = new Date(ms);
  const base = `${formatDate(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return millis && d.getUTCMilliseconds() ? `${base}.${String(d.getUTCMilliseconds()).padStart(3, "0")}` : base;
}

export function cellType(cell: CellObject | undefined, ctx: Ctx): ColType {
  if (!cell || cell.t === "z" || cell.t === "e") return "empty";
  if (cell.t === "b") return "bool";
  const ms = cellDateMs(cell, ctx);
  if (ms !== null) return isMidnight(ms) ? "date" : "timestamp";
  if (cell.t === "d") return "text";
  if (cell.t === "n") return isIntegral(cell.v as number) ? "int" : "float";
  const s = String(cell.v ?? "");
  return s.trim() ? "text" : "empty";
}

export function cellText(cell: CellObject | undefined, ctx: Ctx): string | null {
  if (!cell || cell.t === "z" || cell.t === "e") return null;
  if (cell.t === "b") return cell.v ? "true" : "false";
  const ms = cellDateMs(cell, ctx);
  if (ms !== null) return timestampText(ms, false);
  if (cell.t === "n") {
    const f = cell.v as number;
    return isIntegral(f) ? String(Math.trunc(f)) : String(f);
  }
  const s = String(cell.v ?? "");
  return s.trim() ? s : null;
}

function typedText(cell: CellObject | undefined, t: ColType, ctx: Ctx): string | null {
  if (!cell || cell.t === "z" || cell.t === "e") return null;
  switch (t) {
    case "int":
      return cell.t === "n" ? String(Math.trunc(cell.v as number)) : null;
    case "float":
      return cell.t === "n" ? String(cell.v) : null;
    case "bool":
      return cell.t === "b" ? (cell.v ? "true" : "false") : null;
    case "date": {
      const ms = cellDateMs(cell, ctx);
      return ms === null ? null : formatDate(ms);
    }
    case "timestamp": {
      const ms = cellDateMs(cell, ctx);
      return ms === null ? null : timestampText(ms, true);
    }
    default:
      return cellText(cell, ctx);
  }
}

/** Unique, non-empty column names from the header row (case-insensitive, `_2` suffixes). */
export function columnNames(header: (string | null)[] | null, width: number): string[] {
  const seen = new Set<string>();
  return Array.from({ length: width }, (_, i) => {
    const raw = header?.[i]?.trim() || `column_${i + 1}`;
    let name = raw;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${raw}_${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

export async function importXlsx(
  db: Db,
  id: string,
  bytes: Uint8Array,
  fileName: string,
  sheet: string,
  header: boolean,
): Promise<void> {
  const wb = await readWorkbook(bytes, fileName, { cellNF: true, dense: true, sheets: sheet });
  if (!wb.SheetNames.includes(sheet)) throw appError("emptySheet", `${sheet} (not found)`);
  const XLSX = await import("xlsx");
  const ctx: Ctx = {
    isDate: (fmt) => XLSX.SSF.is_date(fmt),
    date1904: !!wb.Workbook?.WBProps?.date1904,
  };
  const ws = wb.Sheets[sheet];
  const dense = ((ws as unknown as { "!data"?: (CellObject | undefined)[][] })["!data"] ?? []) as (
    | (CellObject | undefined)[]
    | undefined
  )[];

  // Bounding box of used cells, like calamine's range (which does not start at A1 by default).
  let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
  dense.forEach((row, r) =>
    row?.forEach((cell, c) => {
      if (!cell || cell.t === "z") return;
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
    }),
  );
  if (maxR < 0) throw appError("emptySheet", sheet);
  const width = maxC - minC + 1;
  const rowCells = (r: number) => Array.from({ length: width }, (_, c) => dense[r]?.[minC + c]);

  let first = minR;
  const headerRow = header ? rowCells(first++) : null;
  const data: (CellObject | undefined)[][] = [];
  for (let r = first; r <= maxR; r++) {
    const cells = rowCells(r);
    if (cells.some((c) => cellType(c, ctx) !== "empty")) data.push(cells);
  }
  if (!data.length) throw appError("emptySheet", sheet);

  const names = columnNames(headerRow?.map((c) => cellText(c, ctx)) ?? null, width);
  const types: ColType[] = new Array(width).fill("empty");
  for (const row of data) row.forEach((cell, i) => (types[i] = mergeType(types[i], cellType(cell, ctx))));

  const columns: TypedColumn[] = names.map((name, i) => ({ name, type: SQL_TYPE[types[i]] }));
  const rows = (function* () {
    for (const row of data) yield row.map((cell, i) => typedText(cell, types[i], ctx));
  })();
  await loadTypedCsv(db, tableName(id), columns, new TextEncoder().encode(csvText(columns, rows)));
}
