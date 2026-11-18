/** CSV import through DuckDB `read_csv_auto`; a port of `src-tauri/src/import/csv.rs`. */

import type { CsvOptions } from "@/types/dataset";
import type { AppError } from "@/types/errors";
import type { Db } from "./db";
import { appError, dbError, queryError } from "./errors";
import { quoteIdent, quoteLiteral, tableName } from "./ident";
import { rowCount } from "./schema";

/** Built-in DuckDB encodings; others would need an extension download, which we never do. */
export const ENCODINGS = ["utf-8", "utf-16", "latin-1"];
export const DELIMITERS = [",", ";", "\t", "|", ":"];

export function csvOptionsSql(opts: CsvOptions): string {
  const parts = ["auto_detect = true", "sample_size = 20480", "skip = 0"];
  const d = opts.delimiter;
  if (d) {
    if (!DELIMITERS.includes(d)) throw queryError(`unsupported delimiter ${JSON.stringify(d)}`);
    parts.push(`delim = ${d === "\t" ? "'\\t'" : quoteLiteral(d)}`);
  }
  if (opts.header != null) parts.push(`header = ${opts.header}`);
  if (opts.encoding) {
    const e = opts.encoding.toLowerCase();
    if (!ENCODINGS.includes(e)) throw appError("unsupportedEncoding", `${e} (supported: ${ENCODINGS.join(", ")})`);
    parts.push(`encoding = ${quoteLiteral(e)}`);
  }
  if (opts.skipMalformed) parts.push("ignore_errors = true");
  return parts.join(", ");
}

const firstLines = (s: string) => s.split("\n").slice(0, 3).join(" ").trim();

/** Map DuckDB CSV failures to typed errors the UI can explain. */
export function classifyCsvError(e: unknown): AppError {
  const err = dbError(e);
  if (err.kind !== "database") return err;
  const msg = err.message.replace(/^Database error: /, "");
  const lower = msg.toLowerCase();
  if (lower.includes("invalid unicode") || lower.includes("byte sequence")) {
    return appError("unsupportedEncoding", firstLines(msg));
  }
  if (lower.includes("no files found") || lower.includes("no such file")) return appError("fileNotFound", firstLines(msg));
  if (lower.includes("csv") || lower.includes("column") || lower.includes("convert")) {
    return appError("malformedRows", `${firstLines(msg)} Enable "Skip malformed rows" to import the remaining rows.`);
  }
  return err;
}

/** `fileName` must already be registered with the database. */
export async function importCsv(db: Db, id: string, fileName: string, size: number, opts: CsvOptions): Promise<void> {
  if (size === 0) throw appError("emptyFile");
  const table = quoteIdent(tableName(id));
  const sql = `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_csv_auto(${quoteLiteral(fileName)}, ${csvOptionsSql(opts)})`;
  try {
    await db.query(sql);
  } catch (e) {
    throw classifyCsvError(e);
  }
  if ((await rowCount(db, tableName(id))) === 0) {
    await db.query(`DROP TABLE IF EXISTS ${table}`);
    throw appError("emptyFile");
  }
}
