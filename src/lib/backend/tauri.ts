/** Desktop backend: typed wrappers around Tauri `invoke`. Argument keys are camelCase (Tauri converts them). */

import { invoke } from "@tauri-apps/api/core";
import type { Backend } from "./types";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args);
  if (import.meta.env.DEV) {
    const { mockInvoke } = await import("../mockBackend");
    return mockInvoke<T>(cmd, args);
  }
  throw { kind: "internal", message: "DataCanvas must run inside the desktop app." };
}

export const tauriBackend: Backend = {
  listRecentProjects: () => call("list_recent_projects"),
  addRecentProject: (path, name) => call("add_recent_project", { path, name }),
  removeRecentProject: (path) => call("remove_recent_project", { path }),
  clearRecentProjects: () => call("clear_recent_projects"),
  getSetting: (key) => call("get_setting", { key }),
  setSetting: (key, value) => call("set_setting", { key, value }),

  importCsv: (path, options, name) => call("import_csv", { path, options, name: name ?? null }),
  listXlsxSheets: (path) => call("list_xlsx_sheets", { path }),
  importXlsx: (path, sheet, header, name) => call("import_xlsx", { path, sheet, header, name: name ?? null }),
  listDatasets: () => call("list_datasets"),
  getDataset: (id) => call("get_dataset", { id }),
  renameDataset: (id, name) => call("rename_dataset", { id, name }),
  removeDataset: (id) => call("remove_dataset", { id }),
  previewDataset: (id, offset, limit, sort) => call("preview_dataset", { id, offset, limit, sort: sort ?? null }),
  columnStats: (id, column) => call("column_stats", { id, column }),
  distinctValues: (id, column, search, limit) =>
    call("distinct_values", { id, column, search: search ?? null, limit: limit ?? null }),
  setColumnTypes: (id, overrides) => call("set_column_types", { id, overrides }),
  fingerprintFile: (path) => call("fingerprint_file", { path }),

  runQuery: (spec, queryId) => call("run_query", { spec, queryId: queryId ?? null }),
  cancelQuery: (queryId) => call("cancel_query", { queryId }),
  parseMetricExpression: (datasetId, expression) => call("parse_metric_expression", { datasetId, expression }),

  saveProject: (path, mode, project) => call("save_project", { path, mode, project }),
  openProject: (path) => call("open_project", { path }),
  closeProject: () => call("close_project"),
  reloadDataset: (id) => call("reload_dataset", { id }),
  relocateDataset: (id, path) => call("relocate_dataset", { id, path }),
  writeRecovery: (projectId, mode, project) => call("write_recovery", { projectId, mode, project }),
  listRecovery: () => call("list_recovery"),
  restoreRecovery: (projectId) => call("restore_recovery", { projectId }),
  deleteRecovery: (projectId) => call("delete_recovery", { projectId }),
  confirmExit: () => call("confirm_exit"),
  takePendingOpenFiles: () => call("take_pending_open_files"),

  exportDatasetCsv: (datasetId, path) => call("export_dataset_csv", { datasetId, path }),
  exportQueryCsv: (spec, path, labels, queryId) =>
    call("export_query_csv", { spec, path, labels, queryId: queryId ?? null }),
  /** Raw IPC body (no JSON/base64 round-trip); the path travels percent-encoded in a header. */
  writeExportFile: (path, bytes) =>
    invoke<void>("write_export_file", bytes, {
      headers: { "x-export-path": encodeURIComponent(path) },
    }),
};
