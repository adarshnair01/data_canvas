/**
 * Load rows into a DuckDB table with explicit column types via an in-memory CSV. Used for Excel
 * sheets, embedded project data and Parquet read in JS (this Wasm build has no Parquet extension,
 * and extensions are never fetched).
 */

import type { Db } from "./db";
import { quoteIdent, quoteLiteral } from "./ident";

export interface TypedColumn {
  name: string;
  /** DuckDB type, e.g. `BIGINT`; anything unrecognised loads as VARCHAR. */
  type: string;
}

const SAFE_TYPE = /^(BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|DOUBLE|FLOAT|REAL|BOOLEAN|DATE|TIME|TIMESTAMP|TIMESTAMP WITH TIME ZONE|TIMESTAMPTZ|TIMESTAMP_S|TIMESTAMP_MS|TIMESTAMP_NS|VARCHAR|UUID|DECIMAL\(\d{1,2},\s?\d{1,2}\))$/;

export function loadableType(t: string): string {
  const up = t.trim().toUpperCase();
  return SAFE_TYPE.test(up) ? up : "VARCHAR";
}

/** CSV field: `null` is an empty unquoted field (NULL); text is always quoted. */
export function csvField(v: string | null): string {
  if (v === null) return "";
  return `"${v.replaceAll('"', '""')}"`;
}

export function csvText(columns: TypedColumn[], rows: Iterable<(string | null)[]>): string {
  const out = [columns.map((c) => csvField(c.name)).join(",")];
  for (const r of rows) out.push(r.map(csvField).join(","));
  return out.join("\n") + "\n";
}

let seq = 0;

/** Create `table` from CSV bytes whose header row matches `columns`. */
export async function loadTypedCsv(db: Db, table: string, columns: TypedColumn[], csv: Uint8Array): Promise<void> {
  const file = `typed_${Date.now().toString(36)}_${++seq}.csv`;
  await db.registerFile(file, csv);
  const struct = columns.map((c) => `${quoteLiteral(c.name)}: ${quoteLiteral(loadableType(c.type))}`).join(", ");
  try {
    await db.query(
      `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS SELECT * FROM read_csv(${quoteLiteral(file)}, header = true, auto_detect = false, delim = ',', quote = '"', escape = '"', columns = {${struct}})`,
    );
  } finally {
    await db.dropFile(file);
  }
}
