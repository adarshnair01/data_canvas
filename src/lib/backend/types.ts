/**
 * The storage/query backend the UI talks to. Desktop implements it with Tauri `invoke` (Rust +
 * native DuckDB); the web build implements it in the browser with DuckDB-Wasm.
 *
 * Paths are opaque strings. On desktop they are file-system paths; on the web they are handles
 * from `webFiles.ts` (a picked or dropped `File`) or plain download names.
 */

import type {
  ColumnStats,
  CsvOptions,
  DatasetMeta,
  Fingerprint,
  LogicalType,
  PreviewPage,
  ValueCount,
} from "@/types/dataset";
import type { ParsedExpression } from "@/types/metrics";
import type {
  DatasetLoad,
  OpenedProject,
  ProjectDoc,
  ProjectStorageMode,
  RecoverySummary,
  SavedProject,
} from "@/types/project";
import type { QueryResult, QuerySpec, SortDir } from "@/types/query";

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedMs: number;
}

export interface ExportResult {
  path: string;
  rows: number;
}

/** CSV header for one QuerySpec output id. */
export interface ColumnLabel {
  id: string;
  label: string;
}

export interface Backend {
  listRecentProjects(): Promise<RecentProject[]>;
  addRecentProject(path: string, name: string): Promise<RecentProject[]>;
  removeRecentProject(path: string): Promise<RecentProject[]>;
  clearRecentProjects(): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  importCsv(path: string, options: CsvOptions, name?: string): Promise<DatasetMeta>;
  listXlsxSheets(path: string): Promise<string[]>;
  importXlsx(path: string, sheet: string, header: boolean, name?: string): Promise<DatasetMeta>;
  listDatasets(): Promise<DatasetMeta[]>;
  getDataset(id: string): Promise<DatasetMeta>;
  renameDataset(id: string, name: string): Promise<DatasetMeta>;
  removeDataset(id: string): Promise<void>;
  previewDataset(
    id: string,
    offset: number,
    limit: number,
    sort?: { column: string; dir: SortDir } | null,
  ): Promise<PreviewPage>;
  columnStats(id: string, column: string): Promise<ColumnStats>;
  distinctValues(id: string, column: string, search?: string, limit?: number): Promise<ValueCount[]>;
  setColumnTypes(id: string, overrides: Record<string, LogicalType>): Promise<DatasetMeta>;
  fingerprintFile(path: string): Promise<Fingerprint>;

  runQuery(spec: QuerySpec, queryId?: string): Promise<QueryResult>;
  cancelQuery(queryId: string): Promise<boolean>;
  parseMetricExpression(datasetId: string, expression: string): Promise<ParsedExpression>;

  saveProject(path: string, mode: ProjectStorageMode, project: ProjectDoc): Promise<SavedProject>;
  openProject(path: string): Promise<OpenedProject>;
  closeProject(): Promise<void>;
  reloadDataset(id: string): Promise<DatasetLoad>;
  relocateDataset(id: string, path: string): Promise<DatasetLoad>;
  writeRecovery(projectId: string, mode: ProjectStorageMode, project: ProjectDoc): Promise<void>;
  listRecovery(): Promise<RecoverySummary[]>;
  restoreRecovery(projectId: string): Promise<OpenedProject>;
  deleteRecovery(projectId: string): Promise<void>;
  /** Quit confirmed: lets the backend remove recovery snapshots and exit. */
  confirmExit(): Promise<void>;
  /** `.datacanvas` files the OS asked us to open before the UI was listening. */
  takePendingOpenFiles(): Promise<string[]>;

  exportDatasetCsv(datasetId: string, path: string): Promise<ExportResult>;
  exportQueryCsv(spec: QuerySpec, path: string, labels: ColumnLabel[], queryId?: string): Promise<ExportResult>;
  writeExportFile(path: string, bytes: Uint8Array): Promise<void>;
}
