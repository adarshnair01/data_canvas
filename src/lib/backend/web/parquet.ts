/** Read a desktop Portable project's Parquet copy in JS (no DuckDB Parquet extension in Wasm). */

import type { TypedColumn } from "./typedCsv";
import { csvText } from "./typedCsv";
import { formatDate, formatTimestamp } from "./values";

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return formatTimestamp(v.getTime());
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
}

export async function parquetToCsv(bytes: Uint8Array, columns: TypedColumn[]): Promise<Uint8Array> {
  const { parquetReadObjects } = await import("hyparquet");
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const rows = await parquetReadObjects({
    file: buf,
    parsers: {
      dateFromDays: (days: number) => formatDate(days * 86_400_000),
      timestampFromMilliseconds: (ms: bigint) => formatTimestamp(Number(ms)),
      timestampFromMicroseconds: (us: bigint) => formatTimestamp(Number(us) / 1000),
      timestampFromNanoseconds: (ns: bigint) => formatTimestamp(Number(ns / 1000n) / 1000),
    },
  });
  const names = columns.map((c) => c.name);
  return new TextEncoder().encode(csvText(columns, (function* () {
    for (const r of rows) yield names.map((n) => text(r[n]));
  })()));
}
