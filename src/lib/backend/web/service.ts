/**
 * The web backend: the same commands as the Rust side (`src-tauri/src/commands/*`,
 * `project/service.rs`), implemented over DuckDB-Wasm in the browser. Files never leave the
 * machine: inputs are `File` objects read locally, outputs are downloads or files picked in the browser's save dialog.
 */

import type { CsvOptions, DatasetMeta, DatasetSource, Fingerprint, LogicalType } from "@/types/dataset";
import type {
  DatasetLoad,
  OpenedProject,
  ProjectDoc,
  ProjectFile,
  ProjectFileDataset,
  ProjectStorageMode,
  RecoverySummary,
  SavedProject,
  SchemaDiff,
} from "@/types/project";
import { PROJECT_FORMAT_VERSION } from "@/types/project";
import type { QueryResult, QuerySpec } from "@/types/query";
import type { Backend, ColumnLabel, ExportResult } from "../types";
import { importCsv } from "./csvImport";
import type { Db } from "./db";
import { appError, queryError } from "./errors";
import { parseExpression } from "./expr";
import { fingerprintFile } from "./fingerprint";
import { quoteIdent, quoteLiteral, tableName, validateDatasetId, viewName } from "./ident";
import { parquetToCsv } from "./parquet";
import { APP_VERSION, embeddedCsvEntry, readArchive, writeArchive } from "./projectFormat";
import { buildExportQuery, buildQuery, type BuiltQuery } from "./queryBuilder";
import type { RecoveryStore } from "./recoveryStore";
import { columnStats, createView, describe, detectSchema, distinctValues, preview } from "./schema";
import { paramValue } from "./sql";
import { loadTypedCsv, type TypedColumn } from "./typedCsv";
import { importXlsx, listSheets } from "./xlsxImport";

export interface Settings {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface WebBackendDeps {
  db: Db;
  recovery: RecoveryStore;
  settings: Settings;
  /** The `File` behind a picked/dropped handle (see `webFiles.ts`). */
  getFile(path: string): File | undefined;
  /** Write bytes to a save target from `pickSaveTarget`, or download under the path's name. */
  save(path: string, bytes: Uint8Array, mime: string): Promise<void>;
}

const MIME = {
  csv: "text/csv;charset=utf-8",
  png: "image/png",
  pdf: "application/pdf",
  project: "application/octet-stream",
};

const stem = (name: string) => name.replace(/\.[^.]+$/, "") || "Dataset";
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;
const newDatasetId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const now = () => new Date().toISOString();

export function fingerprintChanged(before: Fingerprint, after: Fingerprint): boolean {
  return before.size !== after.size || before.partialSha256 !== after.partialSha256;
}

export function schemaDiff(before: DatasetMeta, after: DatasetMeta): SchemaDiff {
  const find = (cols: DatasetMeta["columns"], n: string) => cols.find((c) => c.name === n)?.logicalType;
  return {
    added: after.columns.filter((c) => !find(before.columns, c.name)).map((c) => c.name),
    removed: before.columns.filter((c) => !find(after.columns, c.name)).map((c) => c.name),
    typeChanged: before.columns.flatMap((b) => {
      const a = find(after.columns, b.name);
      return a && a !== b.logicalType ? [{ name: b.name, before: b.logicalType, after: a }] : [];
    }),
    rowCountBefore: before.rowCount,
    rowCountAfter: after.rowCount,
  };
}

const columnsChanged = (d: SchemaDiff) => !!(d.added.length || d.removed.length || d.typeChanged.length);

/** Column names and DuckDB types of the raw imported table (before type overrides). */
export const rawColumns = (meta: DatasetMeta): TypedColumn[] =>
  meta.columns.map((c) => ({ name: c.name, type: c.originalType ?? c.duckType }));

function toMeta(ds: ProjectFileDataset | DatasetMeta): DatasetMeta {
  const { id, name, source, columns, rowCount, fingerprint, typeOverrides, importedAt } = ds;
  return { id, name, source, columns, rowCount, fingerprint, typeOverrides: typeOverrides ?? {}, importedAt };
}

function validateProjectId(id: string) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw appError("internal", `invalid project id '${id}'`);
}

let fileSeq = 0;

export class WebBackend implements Backend {
  private datasets = new Map<string, DatasetMeta>();
  /** Source files picked this session, so Reload source works without asking again. */
  private sources = new Map<string, File>();
  /** Datasets of the open project that could not be loaded; saved back unchanged. */
  private unresolved = new Map<string, ProjectFileDataset>();
  private projectPath: string | null = null;
  /** Raw-table version per dataset, and the version last copied into recovery storage. */
  private versions = new Map<string, number>();
  private persisted = new Map<string, number>();

  constructor(private deps: WebBackendDeps) {}

  private get db() {
    return this.deps.db;
  }

  private dataset(id: string): DatasetMeta {
    const meta = this.datasets.get(id);
    if (!meta) throw appError("unknownDataset", id);
    return meta;
  }

  private put(meta: DatasetMeta, tableChanged: boolean) {
    this.datasets.set(meta.id, meta);
    if (tableChanged) this.versions.set(meta.id, (this.versions.get(meta.id) ?? 0) + 1);
  }

  private requireFile(path: string): File {
    const f = this.deps.getFile(path);
    if (!f) throw appError("fileNotFound", baseName(path));
    return f;
  }

  private registered(): DatasetMeta[] {
    return [...this.datasets.values()].sort((a, b) =>
      a.importedAt === b.importedAt ? a.id.localeCompare(b.id) : a.importedAt.localeCompare(b.importedAt),
    );
  }

  private async dropDataset(id: string) {
    await this.db.query(`DROP VIEW IF EXISTS ${quoteIdent(viewName(id))}; DROP TABLE IF EXISTS ${quoteIdent(tableName(id))};`);
  }

  private async finishTable(id: string, overrides: Record<string, LogicalType>) {
    const base = await describe(this.db, tableName(id));
    const kept = Object.fromEntries(Object.entries(overrides ?? {}).filter(([n]) => base.some(([b]) => b === n)));
    await createView(this.db, id, kept);
    const { columns, rowCount } = await detectSchema(this.db, id, kept);
    return { typeOverrides: kept, columns, rowCount };
  }

  private async finishImport(id: string, name: string, source: DatasetSource, fingerprint: Fingerprint) {
    await createView(this.db, id, {});
    const { columns, rowCount } = await detectSchema(this.db, id, {});
    const meta: DatasetMeta = { id, name, source, columns, rowCount, fingerprint, typeOverrides: {}, importedAt: now() };
    this.put(meta, true);
    return meta;
  }

  private async loadCsvFile(id: string, file: File, opts: CsvOptions) {
    const name = `src_${id}_${++fileSeq}.csv`;
    await this.db.registerFile(name, file);
    try {
      await importCsv(this.db, id, name, file.size, opts);
    } finally {
      await this.db.dropFile(name);
    }
  }

  private async loadXlsxFile(id: string, file: File, sheet: string, header: boolean) {
    await importXlsx(this.db, id, new Uint8Array(await file.arrayBuffer()), file.name, sheet, header);
  }

  private async copyToBytes(selectSql: string, params: BuiltQuery["params"] = []) {
    const name = `export_${Date.now().toString(36)}_${++fileSeq}.csv`;
    await this.db.prepareOutput(name);
    const r = await this.db.query(
      `COPY (${selectSql}) TO ${quoteLiteral(name)} (FORMAT csv, HEADER true, DELIMITER ',')`,
      params.map(paramValue),
    );
    try {
      return { bytes: await this.db.readFile(name), rows: Number(r.rows[0]?.[0] ?? 0) };
    } finally {
      await this.db.dropFile(name);
    }
  }

  private rawTableCsv(id: string) {
    return this.copyToBytes(`SELECT * FROM ${quoteIdent(tableName(id))}`);
  }

  // -- settings and recent projects ---------------------------------------------------------

  /** A browser cannot reopen a file by path, so there is no recent-projects list on the web. */
  async listRecentProjects() {
    return [];
  }
  async addRecentProject() {
    return [];
  }
  async removeRecentProject() {
    return [];
  }
  async clearRecentProjects() {}
  async getSetting(key: string) {
    return this.deps.settings.get(key);
  }
  async setSetting(key: string, value: string) {
    this.deps.settings.set(key, value);
  }

  // -- datasets ------------------------------------------------------------------------------

  async importCsv(path: string, options: CsvOptions, name?: string) {
    const file = this.requireFile(path);
    const fingerprint = await fingerprintFile(file);
    const id = newDatasetId();
    await this.loadCsvFile(id, file, options);
    this.sources.set(id, file);
    const source: DatasetSource = { kind: "csv", path: file.name, csvOptions: options, header: options.header ?? true };
    return this.finishImport(id, name ?? stem(file.name), source, fingerprint);
  }

  async listXlsxSheets(path: string) {
    const file = this.requireFile(path);
    return listSheets(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  async importXlsx(path: string, sheet: string, header: boolean, name?: string) {
    const file = this.requireFile(path);
    const fingerprint = await fingerprintFile(file);
    const id = newDatasetId();
    await this.loadXlsxFile(id, file, sheet, header);
    this.sources.set(id, file);
    const source: DatasetSource = { kind: "xlsx", path: file.name, sheet, header };
    return this.finishImport(id, name ?? `${stem(file.name)} – ${sheet}`, source, fingerprint);
  }

  async listDatasets() {
    return [...this.datasets.values()].sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  }

  async getDataset(id: string) {
    return this.dataset(id);
  }

  async renameDataset(id: string, name: string) {
    const meta = this.dataset(id);
    const trimmed = name.trim();
    if (!trimmed) throw queryError("dataset name cannot be empty");
    const next = { ...meta, name: trimmed };
    this.put(next, false);
    return next;
  }

  async removeDataset(id: string) {
    this.dataset(id);
    await this.dropDataset(id);
    this.datasets.delete(id);
    this.sources.delete(id);
  }

  async previewDataset(id: string, offset: number, limit: number, sort?: { column: string; dir: "asc" | "desc" } | null) {
    const meta = this.dataset(id);
    return preview(this.db, id, meta.columns, meta.rowCount, offset, limit, sort);
  }

  private column(id: string, column: string) {
    const col = this.dataset(id).columns.find((c) => c.name === column);
    if (!col) throw appError("unknownColumn", column);
    return col;
  }

  async columnStats(id: string, column: string) {
    return columnStats(this.db, id, this.column(id, column));
  }

  async distinctValues(id: string, column: string, search?: string, limit?: number) {
    return distinctValues(this.db, id, this.column(id, column), search, limit ?? 200);
  }

  async setColumnTypes(id: string, overrides: Record<string, LogicalType>) {
    const meta = this.dataset(id);
    const kept = Object.fromEntries(Object.entries(overrides).filter(([, t]) => t !== "other"));
    await createView(this.db, id, kept);
    const { columns, rowCount } = await detectSchema(this.db, id, kept);
    const next = { ...meta, columns, rowCount, typeOverrides: kept };
    this.put(next, false);
    return next;
  }

  async fingerprintFile(path: string) {
    return fingerprintFile(this.requireFile(path));
  }

  // -- queries -------------------------------------------------------------------------------

  async runQuery(spec: QuerySpec): Promise<QueryResult> {
    const meta = this.dataset(spec.datasetId);
    const built = buildQuery(spec, meta.columns);
    const started = performance.now();
    const r = await this.db.query(built.sql, built.params.map(paramValue));
    return {
      columns: built.columns,
      rows: r.rows.slice(0, built.limit),
      truncated: r.rows.length > built.limit,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  /** Queries on one DuckDB-Wasm connection run in order; stale results are ignored by the UI. */
  async cancelQuery() {
    return false;
  }

  async parseMetricExpression(datasetId: string, expression: string) {
    return parseExpression(expression, this.dataset(datasetId).columns);
  }

  // -- exports -------------------------------------------------------------------------------

  async exportDatasetCsv(datasetId: string, path: string): Promise<ExportResult> {
    this.dataset(datasetId);
    const { bytes, rows } = await this.copyToBytes(`SELECT * FROM ${quoteIdent(viewName(datasetId))}`);
    await this.deps.save(path, bytes, MIME.csv);
    return { path: baseName(path), rows };
  }

  async exportQueryCsv(spec: QuerySpec, path: string, labels: ColumnLabel[]): Promise<ExportResult> {
    const meta = this.dataset(spec.datasetId);
    const built = buildExportQuery(spec, meta.columns);
    const used = new Set<string>();
    const select = built.columns.map((c) => {
      const base = labels.find((l) => l.id === c.id)?.label.trim() || c.id;
      let label = base;
      for (let n = 2; used.has(label.toLowerCase()); n++) label = `${base} (${n})`;
      used.add(label.toLowerCase());
      return `${quoteIdent(c.id)} AS ${quoteIdent(label)}`;
    });
    const { bytes, rows } = await this.copyToBytes(`SELECT ${select.join(", ")} FROM (${built.sql}) AS q`, built.params);
    await this.deps.save(path, bytes, MIME.csv);
    return { path: baseName(path), rows };
  }

  async writeExportFile(path: string, bytes: Uint8Array) {
    const name = baseName(path);
    const ext = name.toLowerCase().split(".").pop();
    if (ext !== "png" && ext !== "pdf") throw appError("unsupportedFile", `exports must be .png or .pdf, got '${name}'`);
    if (!bytes.length) throw appError("io", "nothing to write");
    await this.deps.save(path, bytes, MIME[ext]);
  }

  // -- projects ------------------------------------------------------------------------------

  private projectEntries(): ProjectFileDataset[] {
    return [
      ...this.registered().map((meta) => ({ ...meta })),
      ...[...this.unresolved.values()].map(({ embedded: _e, ...rest }) => rest),
    ];
  }

  /** Web projects are always Portable: the browser cannot re-read linked files later. */
  async saveProject(path: string, _mode: ProjectStorageMode, project: ProjectDoc): Promise<SavedProject> {
    const entries = this.projectEntries();
    const embedded = new Map<string, Uint8Array>();
    for (const e of entries) {
      if (!this.datasets.has(e.id)) continue;
      const entry = embeddedCsvEntry(e.id);
      embedded.set(entry, (await this.rawTableCsv(e.id)).bytes);
      e.embedded = entry;
    }
    const savedAt = now();
    const body: ProjectFile = { mode: "portable", savedAt, project, datasets: entries };
    await this.deps.save(path, writeArchive(body, embedded), MIME.project);
    this.projectPath = path;
    return { path, mode: "portable", savedAt, datasetCount: entries.length };
  }

  private async clearRegistry() {
    for (const id of this.datasets.keys()) await this.dropDataset(id);
    this.datasets.clear();
    this.sources.clear();
    this.unresolved.clear();
  }

  /** Load a dataset's raw rows from typed CSV (or Parquet) bytes and register it. */
  private async loadStored(saved: DatasetMeta, data: Uint8Array, entry: string): Promise<DatasetMeta> {
    const columns = rawColumns(saved);
    const csv = entry.endsWith(".parquet") ? await parquetToCsv(data, columns) : data;
    await loadTypedCsv(this.db, tableName(saved.id), columns, csv);
    const finished = await this.finishTable(saved.id, saved.typeOverrides);
    const meta = { ...toMeta(saved), ...finished };
    this.put(meta, true);
    return meta;
  }

  private async loadAll(
    entries: ProjectFileDataset[],
    stored: (ds: ProjectFileDataset) => Promise<{ data: Uint8Array; entry: string } | null>,
  ): Promise<DatasetLoad[]> {
    await this.clearRegistry();
    const loads: DatasetLoad[] = [];
    for (const ds of entries) {
      const base = { id: ds.id, name: ds.name };
      let load: DatasetLoad;
      try {
        validateDatasetId(ds.id);
        const s = await stored(ds);
        load = s
          ? { ...base, status: "ok", loadedFrom: "embedded", meta: await this.loadStored(toMeta(ds), s.data, s.entry) }
          : { ...base, status: "missing", searched: [ds.relativePath, ds.source?.path].filter((p): p is string => !!p) };
      } catch (e) {
        load = { ...base, status: "failed", message: (e as { message?: string }).message ?? String(e) };
      }
      if (!load.meta) this.unresolved.set(ds.id, ds);
      loads.push(load);
    }
    return loads;
  }

  async openProject(path: string): Promise<OpenedProject> {
    const file = this.requireFile(path);
    // Parse and migrate before touching the session so a bad file changes nothing.
    const archive = readArchive(new Uint8Array(await file.arrayBuffer()));
    const datasets = await this.loadAll(archive.project.datasets, async (ds) => {
      const data = ds.embedded ? archive.entries[ds.embedded] : undefined;
      return data && ds.embedded ? { data, entry: ds.embedded } : null;
    });
    this.projectPath = file.name;
    return {
      path: file.name,
      mode: archive.project.mode,
      appVersion: archive.manifest.appVersion,
      migratedFrom: archive.migratedFrom,
      project: archive.project.project,
      datasets,
    };
  }

  async closeProject() {
    this.projectPath = null;
    this.unresolved.clear();
  }

  private findDataset(id: string): DatasetMeta {
    const meta = this.datasets.get(id);
    if (meta) return meta;
    const u = this.unresolved.get(id);
    if (!u) throw appError("unknownDataset", id);
    return toMeta(u);
  }

  private async refreshFrom(previous: DatasetMeta, file: File): Promise<DatasetLoad> {
    const fingerprint = await fingerprintFile(file);
    if (previous.source.kind === "xlsx") {
      if (!previous.source.sheet) throw queryError("Excel dataset has no sheet name");
      await this.loadXlsxFile(previous.id, file, previous.source.sheet, previous.source.header);
    } else {
      await this.loadCsvFile(previous.id, file, previous.source.csvOptions ?? {});
    }
    const finished = await this.finishTable(previous.id, previous.typeOverrides);
    const meta: DatasetMeta = { ...previous, ...finished, source: { ...previous.source, path: file.name }, fingerprint };
    this.put(meta, true);
    this.sources.set(meta.id, file);
    this.unresolved.delete(meta.id);
    const diff = schemaDiff(previous, meta);
    const fpChanged = fingerprintChanged(previous.fingerprint, fingerprint);
    const base = { id: meta.id, name: meta.name, loadedFrom: "source" as const, meta };
    return fpChanged || columnsChanged(diff)
      ? { ...base, status: "changed", change: { fingerprintChanged: fpChanged, before: previous.fingerprint, after: fingerprint, schema: diff } }
      : { ...base, status: "ok" };
  }

  async reloadDataset(id: string) {
    const meta = this.findDataset(id);
    const file = this.sources.get(id);
    if (!file) throw appError("fileNotFound", meta.source.path);
    return this.refreshFrom(meta, file);
  }

  async relocateDataset(id: string, path: string) {
    return this.refreshFrom(this.findDataset(id), this.requireFile(path));
  }

  // -- autosave and recovery -----------------------------------------------------------------

  async writeRecovery(projectId: string, mode: ProjectStorageMode, project: ProjectDoc) {
    validateProjectId(projectId);
    const { recovery } = this.deps;
    for (const meta of this.registered()) {
      const version = this.versions.get(meta.id) ?? 0;
      if (this.persisted.get(meta.id) === version) continue;
      const { bytes } = await this.rawTableCsv(meta.id);
      await recovery.putTable({ datasetId: meta.id, columns: rawColumns(meta), csv: bytes });
      this.persisted.set(meta.id, version);
    }
    await recovery.putSnapshot({
      formatVersion: PROJECT_FORMAT_VERSION,
      projectId,
      projectPath: this.projectPath,
      name: typeof project.name === "string" && project.name ? project.name : "Untitled project",
      savedAt: now(),
      mode,
      project,
      datasets: this.projectEntries(),
    });
  }

  async listRecovery(): Promise<RecoverySummary[]> {
    const snaps = await this.deps.recovery.listSnapshots();
    return snaps
      .filter((s) => s.formatVersion <= PROJECT_FORMAT_VERSION)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .map((s) => ({
        projectId: s.projectId,
        projectPath: s.projectPath,
        name: s.name,
        savedAt: s.savedAt,
        datasetCount: s.datasets.length,
      }));
  }

  async restoreRecovery(projectId: string): Promise<OpenedProject> {
    validateProjectId(projectId);
    const snap = await this.deps.recovery.getSnapshot(projectId);
    if (!snap) throw appError("fileNotFound", `recovery snapshot ${projectId}`);
    if (snap.formatVersion > PROJECT_FORMAT_VERSION) {
      throw appError("unsupportedFile", "recovery snapshot was written by a newer DataCanvas");
    }
    const datasets = await this.loadAll(snap.datasets, async (ds) => {
      const t = await this.deps.recovery.getTable(ds.id);
      return t ? { data: t.csv, entry: "recovery.csv" } : null;
    });
    for (const d of datasets) if (d.meta) this.persisted.set(d.id, this.versions.get(d.id) ?? 0);
    this.projectPath = snap.projectPath;
    return {
      path: snap.projectPath,
      mode: snap.mode,
      appVersion: APP_VERSION,
      migratedFrom: null,
      project: snap.project,
      datasets,
    };
  }

  async deleteRecovery(projectId: string) {
    validateProjectId(projectId);
    const { recovery } = this.deps;
    await recovery.deleteSnapshot(projectId);
    const referenced = new Set((await recovery.listSnapshots()).flatMap((s) => s.datasets.map((d) => d.id)));
    for (const id of await recovery.tableIds()) {
      if (referenced.has(id)) continue;
      await recovery.deleteTable(id);
      this.persisted.delete(id);
    }
  }

  async confirmExit() {}

  async takePendingOpenFiles() {
    return [];
  }
}
