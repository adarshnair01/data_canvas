/** `AppError` values with the same kinds and messages as `src-tauri/src/error.rs`. */

import type { AppError, AppErrorKind } from "@/types/errors";

const PREFIX: Record<AppErrorKind, (detail: string) => string> = {
  fileNotFound: (d) => `File not found: ${d}`,
  unsupportedFile: (d) => `Unsupported file type: ${d}`,
  unsupportedEncoding: (d) => `Unsupported encoding: ${d}`,
  malformedRows: (d) => `Malformed rows: ${d}`,
  emptyFile: () => "The file contains no data",
  emptySheet: (d) => `Sheet '${d}' is empty`,
  invalidQuery: (d) => `Invalid query: ${d}`,
  invalidExpression: (d) => `Invalid expression: ${d}`,
  unknownDataset: (d) => `Unknown dataset: ${d}`,
  unknownColumn: (d) => `Unknown column: ${d}`,
  cancelled: () => "Query cancelled",
  database: (d) => `Database error: ${d}`,
  io: (d) => `I/O error: ${d}`,
  internal: (d) => d,
};

export function appError(kind: AppErrorKind, detail = ""): AppError {
  return { kind, message: PREFIX[kind](detail) };
}

export const queryError = (msg: string) => appError("invalidQuery", msg);

export function exprError(msg: string, position: number): AppError {
  return { ...appError("invalidExpression", msg), position };
}

/** Wrap a DuckDB-Wasm exception the way `From<duckdb::Error>` does. */
export function dbError(e: unknown): AppError {
  if (typeof e === "object" && e && "kind" in e && "message" in e) return e as AppError;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.toUpperCase().includes("INTERRUPT") ? appError("cancelled") : appError("database", msg);
}
