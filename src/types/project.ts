import type { ChartConfig, ChartType, Encoding } from "./chart";
import type { CellValue, DatasetMeta, Fingerprint, LogicalType } from "./dataset";
import type { CalculatedMetric } from "./metrics";
import type { Filter, SortSpec } from "./query";

export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Widget {
  id: string;
  datasetId: string | null;
  chartType: ChartType;
  encoding: Encoding;
  config: ChartConfig;
  /** Widget-level filters, merged with the dashboard's global filters. */
  filters: Filter[];
  /** `by` references a FieldRef id in `encoding`. */
  sort: SortSpec[];
  limit?: number;
}

interface GlobalFilterBase {
  id: string;
  /** Column name; applied to every widget whose dataset has this column. */
  field: string;
  /** Restrict to one dataset, or `null` to match by column name across datasets. */
  datasetId: string | null;
  label?: string;
}

export type GlobalFilter = GlobalFilterBase &
  (
    | { kind: "in"; values: CellValue[] }
    | { kind: "range"; min?: number | null; max?: number | null }
    | { kind: "dateRange"; from?: string | null; to?: string | null }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewGlobalFilter = DistributiveOmit<GlobalFilter, "id">;

export interface Dashboard {
  id: string;
  name: string;
  widgets: Widget[];
  layout: LayoutItem[];
  globalFilters: GlobalFilter[];
}

export interface ProjectDoc {
  id: string;
  name: string;
  dashboards: Dashboard[];
  activeDashboardId: string;
  metrics: CalculatedMetric[];
}

/** `.datacanvas` contents; mirrors `src-tauri/src/project/format.rs`. */
export type ProjectStorageMode = "linked" | "portable";

export interface ProjectManifest {
  formatVersion: number;
  appVersion: string;
}

export interface ProjectFileDataset extends DatasetMeta {
  /** Linked mode: path relative to the project file, resolved before `source.path`. */
  relativePath?: string;
  /** Portable mode: zip entry of the Parquet copy (`data/<id>.parquet`). */
  embedded?: string;
}

export interface ProjectFile {
  mode: ProjectStorageMode;
  savedAt: string;
  project: ProjectDoc;
  datasets: ProjectFileDataset[];
}

export const PROJECT_FORMAT_VERSION = 1;

export interface SchemaDiff {
  added: string[];
  removed: string[];
  typeChanged: { name: string; before: LogicalType; after: LogicalType }[];
  rowCountBefore: number;
  rowCountAfter: number;
}

export interface DatasetChange {
  fingerprintChanged: boolean;
  before: Fingerprint;
  after: Fingerprint;
  /** Absent when the embedded copy was loaded and the source was not re-read. */
  schema: SchemaDiff | null;
}

export type DatasetLoadStatus =
  | { status: "ok" }
  | { status: "changed"; change: DatasetChange }
  | { status: "missing"; searched: string[] }
  | { status: "failed"; message: string };

export type DatasetLoad = DatasetLoadStatus & {
  id: string;
  name: string;
  loadedFrom?: "source" | "embedded";
  meta?: DatasetMeta;
};

export interface OpenedProject {
  /** `null` for a recovered project that was never saved. */
  path: string | null;
  mode: ProjectStorageMode;
  appVersion: string;
  migratedFrom: number | null;
  project: unknown;
  datasets: DatasetLoad[];
}

export interface SavedProject {
  path: string;
  mode: ProjectStorageMode;
  savedAt: string;
  datasetCount: number;
}

export interface RecoverySummary {
  projectId: string;
  projectPath: string | null;
  name: string;
  savedAt: string;
  datasetCount: number;
}
