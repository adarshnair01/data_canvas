/** Arrow result values -> JSON cells, matching `src-tauri/src/db/values.rs`. */

import type { CellValue } from "@/types/dataset";

/** Minimal view of an Arrow table so the converter works with any apache-arrow instance. */
export interface ArrowLike {
  numRows: number;
  schema: { fields: { name: string; typeId: number; type?: { unit?: number } }[] };
  getChildAt(i: number): { get(row: number): unknown } | null;
}

// apache-arrow `Type` enum ids.
const DATE = 8;
const TIME = 9;
const TIMESTAMP = 10;
const LIST = 12;
const STRUCT = 13;
const MAP = 17;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Same text as Rust's `format_timestamp` (and DuckDB's `CAST(ts AS VARCHAR)` for whole seconds). */
export function formatTimestamp(ms: number): string {
  const d = new Date(Math.floor(ms));
  const base = `${formatDate(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const micros = Math.round((ms - Math.floor(ms / 1000) * 1000) * 1000);
  return micros === 0 ? base : `${base}.${pad(micros, 6)}`;
}

function formatTime(micros: number): string {
  const secs = Math.floor(micros / 1_000_000);
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
}

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

function plain(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return formatTimestamp(v.getTime());
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (typeof v === "object" && v !== null && Symbol.iterator in v && typeof (v as { toArray?: unknown }).toArray === "function") {
    return Array.from(v as Iterable<unknown>, plain);
  }
  if (typeof v === "object" && v !== null && "toJSON" in v) return JSON.stringify((v as { toJSON(): unknown }).toJSON());
  return String(v);
}

function convert(v: unknown, typeId: number): CellValue {
  if (v === null || v === undefined) return null;
  switch (typeId) {
    case DATE:
      return formatDate(toMs(v));
    case TIMESTAMP:
      return formatTimestamp(toMs(v));
    case TIME:
      return formatTime(Number(v));
    case LIST:
      return plain(v);
    case STRUCT:
    case MAP:
      return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
    default:
      return plain(v);
  }
}

export interface Rows {
  columns: string[];
  rows: CellValue[][];
}

export function arrowRows(table: ArrowLike): Rows {
  const fields = table.schema.fields;
  const vectors = fields.map((_, i) => table.getChildAt(i));
  const rows: CellValue[][] = new Array(table.numRows);
  for (let r = 0; r < table.numRows; r++) {
    const row: CellValue[] = new Array(fields.length);
    for (let c = 0; c < fields.length; c++) row[c] = convert(vectors[c]?.get(r), fields[c].typeId);
    rows[r] = row;
  }
  return { columns: fields.map((f) => f.name), rows };
}
