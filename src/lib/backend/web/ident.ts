/** Identifier validation and quoting; mirrors `src-tauri/src/db/ident.rs`. */

import { appError, queryError } from "./errors";

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Only where DuckDB cannot bind a parameter (table function arguments). */
export function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw queryError("value contains a NUL character");
  return `'${value.replaceAll("'", "''")}'`;
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

export function validateAlias(alias: string): void {
  if (utf8Length(alias) > 64 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw queryError(`invalid alias '${alias}'`);
  }
}

export function validateDatasetId(id: string): void {
  if (!/^[a-z0-9]{1,64}$/.test(id)) throw appError("unknownDataset", id);
}

export function tableName(id: string): string {
  validateDatasetId(id);
  return `ds_${id}`;
}

export function viewName(id: string): string {
  validateDatasetId(id);
  return `dsv_${id}`;
}
