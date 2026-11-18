/** Mirrors `src-tauri/src/db/spec.rs`. The frontend never builds SQL; it sends this. */

import type { CellValue } from "./dataset";

export type QueryMode = "aggregate" | "raw";
export type DateBucket = "day" | "week" | "month" | "quarter" | "year";
export type Aggregation =
  | "sum"
  | "avg"
  | "count"
  | "count_distinct"
  | "min"
  | "max"
  | "none";
export type SortDir = "asc" | "desc";

export const AGGREGATIONS: Aggregation[] = [
  "sum",
  "avg",
  "count",
  "count_distinct",
  "min",
  "max",
];
export const DATE_BUCKETS: DateBucket[] = ["day", "week", "month", "quarter", "year"];

export interface Dimension {
  /** Output alias: `[A-Za-z_][A-Za-z0-9_]*`, validated in Rust. */
  id: string;
  field: string;
  bucket?: DateBucket;
}

export type MeasureSource =
  | { type: "column"; column: string }
  | { type: "rows" }
  | { type: "expression"; expression: string };

export interface Measure {
  id: string;
  source: MeasureSource;
  agg: Aggregation;
}

export type Filter =
  | { kind: "in"; field: string; values: CellValue[]; exclude?: boolean }
  | { kind: "range"; field: string; min?: number | null; max?: number | null }
  | { kind: "dateRange"; field: string; from?: string | null; to?: string | null }
  | { kind: "contains"; field: string; text: string };

export interface SortSpec {
  /** Id of a dimension or measure in the same spec. */
  by: string;
  dir: SortDir;
}

export interface QuerySpec {
  datasetId: string;
  mode: QueryMode;
  dimensions: Dimension[];
  measures: Measure[];
  filters: Filter[];
  sort: SortSpec[];
  limit?: number;
  offset?: number;
}

export interface OutputColumn {
  id: string;
  role: "dimension" | "measure";
}

export interface QueryResult {
  columns: OutputColumn[];
  rows: CellValue[][];
  truncated: boolean;
  elapsedMs: number;
}

/** Server-side cap on chart results. */
export const CHART_ROW_CAP = 5000;
