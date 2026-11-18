/** Mirrors `src-tauri/src/model.rs`. */

export type LogicalType =
  | "string"
  | "integer"
  | "float"
  | "boolean"
  | "date"
  | "timestamp"
  | "other";

export interface ColumnInfo {
  name: string;
  logicalType: LogicalType;
  duckType: string;
  nullCount: number;
  distinctEstimate: number;
  /** Originally detected DuckDB type when the user overrode the type. */
  originalType?: string;
}

export interface Fingerprint {
  path: string;
  size: number;
  modifiedMs: number;
  /** SHA-256 of size + first 1 MB + last 1 MB. */
  partialSha256: string;
}

export type SourceKind = "csv" | "xlsx";

export interface CsvOptions {
  delimiter?: string | null;
  header?: boolean | null;
  encoding?: "utf-8" | "utf-16" | "latin-1" | null;
  skipMalformed?: boolean;
}

export interface DatasetSource {
  kind: SourceKind;
  path: string;
  sheet?: string;
  csvOptions?: CsvOptions;
  header: boolean;
}

export interface DatasetMeta {
  id: string;
  name: string;
  source: DatasetSource;
  columns: ColumnInfo[];
  rowCount: number;
  fingerprint: Fingerprint;
  typeOverrides: Record<string, LogicalType>;
  importedAt: string;
}

export type CellValue = string | number | boolean | null | CellValue[];

export interface PreviewPage {
  columns: string[];
  rows: CellValue[][];
  offset: number;
  totalRows: number;
}

export interface ValueCount {
  value: CellValue;
  count: number;
}

export interface ColumnStats {
  column: string;
  logicalType: LogicalType;
  rowCount: number;
  nullCount: number;
  distinctCount: number;
  min: CellValue;
  max: CellValue;
  mean: number | null;
  topValues: ValueCount[];
}

export const isNumericType = (t: LogicalType) => t === "integer" || t === "float";
export const isTemporalType = (t: LogicalType) => t === "date" || t === "timestamp";

/** Numeric columns default to measures; everything else to dimensions. */
export const fieldRole = (c: ColumnInfo): "dimension" | "measure" =>
  isNumericType(c.logicalType) ? "measure" : "dimension";
