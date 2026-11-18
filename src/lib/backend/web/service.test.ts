// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectDoc } from "@/types/project";
import type { QuerySpec } from "@/types/query";
import { readArchive } from "./projectFormat";
import { memoryRecoveryStore, type RecoveryStore } from "./recoveryStore";
import { WebBackend } from "./service";
import { openNodeDb } from "./testing/nodeDb";

const FIXTURES = path.resolve(__dirname, "../../../../src-tauri/tests/fixtures");

const doc = (name = "Test"): ProjectDoc => ({ id: "p1", name, dashboards: [], activeDashboardId: "", metrics: [] });

interface Harness {
  backend: WebBackend;
  files: Map<string, File>;
  downloads: { name: string; bytes: Uint8Array }[];
  store: RecoveryStore;
  add(name: string, content: string | Uint8Array): string;
}

async function harness(store: RecoveryStore = memoryRecoveryStore()): Promise<Harness> {
  const files = new Map<string, File>();
  const downloads: Harness["downloads"] = [];
  const settings = new Map<string, string>();
  const backend = new WebBackend({
    db: await openNodeDb(),
    recovery: store,
    settings: { get: (k) => settings.get(k) ?? null, set: (k, v) => void settings.set(k, v) },
    getFile: (p) => files.get(p),
    save: async (name, bytes) => void downloads.push({ name, bytes }),
  });
  return {
    backend,
    files,
    downloads,
    store,
    add(name, content) {
      const handle = `browser-file:${files.size}/${name}`;
      files.set(handle, new File([content as BlobPart], name));
      return handle;
    },
  };
}

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

const SALES = [
  "day,region,amount,qty",
  "2024-01-05,North,10.5,1",
  "2024-01-20,South,20,2",
  "2024-02-03,North,5.25,3",
  "2024-02-14,,7,4",
].join("\n");

describe("WebBackend on DuckDB-Wasm", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("imports CSV with detected types and previews rows", async () => {
    const meta = await h.backend.importCsv(h.add("sales.csv", SALES), {});
    expect(meta.name).toBe("sales");
    expect(meta.rowCount).toBe(4);
    expect(meta.source.path).toBe("sales.csv");
    expect(meta.columns.map((c) => [c.name, c.logicalType])).toEqual([
      ["day", "date"],
      ["region", "string"],
      ["amount", "float"],
      ["qty", "integer"],
    ]);
    const page = await h.backend.previewDataset(meta.id, 0, 2, { column: "amount", dir: "desc" });
    expect(page.rows).toEqual([
      ["2024-01-20", "South", 20, 2],
      ["2024-01-05", "North", 10.5, 1],
    ]);
    const stats = await h.backend.columnStats(meta.id, "region");
    expect(stats.nullCount).toBe(1);
    expect(await h.backend.distinctValues(meta.id, "region")).toEqual([
      { value: "North", count: 2 },
      { value: "South", count: 1 },
      { value: null, count: 1 },
    ]);
  });

  it("runs aggregate queries with filters, buckets and expressions", async () => {
    const meta = await h.backend.importCsv(h.add("sales.csv", SALES), {});
    const spec: QuerySpec = {
      datasetId: meta.id,
      mode: "aggregate",
      dimensions: [{ id: "d0", field: "day", bucket: "month" }],
      measures: [
        { id: "m0", source: { type: "column", column: "amount" }, agg: "sum" },
        { id: "m1", source: { type: "expression", expression: "amount * qty" }, agg: "sum" },
      ],
      filters: [{ kind: "in", field: "region", values: ["North", null] }],
      sort: [{ by: "d0", dir: "asc" }],
    };
    const r = await h.backend.runQuery(spec);
    expect(r.rows).toEqual([
      ["2024-01-01", 10.5, 10.5],
      ["2024-02-01", 12.25, 43.75],
    ]);
    expect(r.truncated).toBe(false);
    await expect(h.backend.parseMetricExpression(meta.id, "amount +")).rejects.toMatchObject({ kind: "invalidExpression" });
    await expect(h.backend.runQuery({ ...spec, datasetId: "nope" })).rejects.toMatchObject({ kind: "unknownDataset" });
  });

  it("flags truncated results", async () => {
    const meta = await h.backend.importCsv(h.add("sales.csv", SALES), {});
    const r = await h.backend.runQuery({
      datasetId: meta.id,
      mode: "raw",
      dimensions: [{ id: "d0", field: "region" }],
      measures: [],
      filters: [],
      sort: [],
      limit: 2,
    });
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("applies and removes type overrides", async () => {
    const meta = await h.backend.importCsv(h.add("sales.csv", SALES), {});
    const next = await h.backend.setColumnTypes(meta.id, { qty: "string" });
    const qty = next.columns.find((c) => c.name === "qty")!;
    expect(qty.logicalType).toBe("string");
    expect(qty.originalType).toBe("BIGINT");
    const back = await h.backend.setColumnTypes(meta.id, {});
    expect(back.columns.find((c) => c.name === "qty")!.logicalType).toBe("integer");
  });

  it("reports malformed CSV rows, then skips them when asked", async () => {
    const handle = h.add("malformed.csv", fixture("malformed.csv"));
    await expect(h.backend.importCsv(handle, { delimiter: ",", header: true })).rejects.toMatchObject({
      kind: "malformedRows",
    });
    const meta = await h.backend.importCsv(handle, { delimiter: ",", header: true, skipMalformed: true });
    expect(meta.rowCount).toBe(49);
    expect(meta.name).toBe("malformed");
  });

  it("imports each sheet of a workbook like the desktop app", async () => {
    const handle = h.add("multi_sheet.xlsx", fixture("multi_sheet.xlsx"));
    expect(await h.backend.listXlsxSheets(handle)).toEqual(["Sales", "Targets", "Notes"]);
    const sales = await h.backend.importXlsx(handle, "Sales", true);
    expect(sales.name).toBe("multi_sheet – Sales");
    expect(sales.rowCount).toBe(12);
    expect(sales.columns.map((c) => c.logicalType)).toEqual(["date", "string", "string", "integer", "float"]);
    const targets = await h.backend.importXlsx(handle, "Targets", true);
    expect(targets.columns.map((c) => c.logicalType)).toEqual(["string", "float", "boolean"]);
    await expect(h.backend.importXlsx(handle, "Notes", true)).rejects.toMatchObject({ kind: "emptySheet" });
    const bad = h.add("malformed.xlsx", fixture("malformed.xlsx"));
    await expect(h.backend.listXlsxSheets(bad)).rejects.toMatchObject({ kind: "unsupportedFile" });
  });

  it("exports query CSV with deduplicated labels as a download", async () => {
    const meta = await h.backend.importCsv(h.add("sales.csv", SALES), {});
    const res = await h.backend.exportQueryCsv(
      {
        datasetId: meta.id,
        mode: "aggregate",
        dimensions: [{ id: "d0", field: "region" }],
        measures: [{ id: "m0", source: { type: "column", column: "amount" }, agg: "sum" }],
        filters: [{ kind: "contains", field: "region", text: "orth" }],
        sort: [],
      },
      "out.csv",
      [
        { id: "d0", label: "Amount" },
        { id: "m0", label: "amount" },
      ],
    );
    expect(res).toEqual({ path: "out.csv", rows: 1 });
    expect(text(h.downloads[0].bytes).trim().split("\n")).toEqual(["Amount,amount (2)", "North,15.75"]);
    await h.backend.exportDatasetCsv(meta.id, "all.csv");
    expect(text(h.downloads[1].bytes).split("\n")[0]).toBe("day,region,amount,qty");
    await expect(h.backend.writeExportFile("x.txt", new Uint8Array([1]))).rejects.toMatchObject({ kind: "unsupportedFile" });
  });

  it("round-trips a portable project with embedded typed CSV", async () => {
    const meta = await h.backend.importCsv(h.add("sales.csv", SALES), {});
    await h.backend.setColumnTypes(meta.id, { qty: "string" });
    const saved = await h.backend.saveProject("My project.datacanvas", "linked", doc());
    expect(saved).toMatchObject({ path: "My project.datacanvas", mode: "portable", datasetCount: 1 });
    const bytes = h.downloads.at(-1)!.bytes;
    const archive = readArchive(bytes);
    expect(Object.keys(archive.entries)).toContain(`data/${meta.id}.csv`);

    const other = await harness();
    const opened = await other.backend.openProject(other.add("My project.datacanvas", bytes));
    expect(opened.mode).toBe("portable");
    expect(opened.datasets).toHaveLength(1);
    const load = opened.datasets[0];
    expect(load).toMatchObject({ status: "ok", loadedFrom: "embedded" });
    expect(load.meta!.rowCount).toBe(4);
    expect(load.meta!.typeOverrides).toEqual({ qty: "string" });
    expect(load.meta!.columns.find((c) => c.name === "day")!.logicalType).toBe("date");
    const page = await other.backend.previewDataset(meta.id, 0, 10);
    expect(page.rows[3]).toEqual(["2024-02-14", null, 7, "4"]);
  });

  it("marks datasets without embedded data as missing, then relocates them", async () => {
    const meta = await h.backend.importCsv(h.add("sales.csv", SALES), {});
    await h.backend.saveProject("p.datacanvas", "portable", doc());
    const archive = readArchive(h.downloads.at(-1)!.bytes);
    const linked = archive.project.datasets.map(({ embedded: _e, ...d }) => d);
    const { writeArchive } = await import("./projectFormat");
    const linkedBytes = writeArchive({ ...archive.project, mode: "linked", datasets: linked }, new Map());

    const other = await harness();
    const opened = await other.backend.openProject(other.add("p.datacanvas", linkedBytes));
    expect(opened.datasets[0]).toMatchObject({ status: "missing", searched: ["sales.csv"] });
    await expect(other.backend.reloadDataset(meta.id)).rejects.toMatchObject({ kind: "fileNotFound" });
    const changed = SALES + "\n2024-03-01,East,1,1";
    const load = await other.backend.relocateDataset(meta.id, other.add("sales.csv", changed));
    expect(load).toMatchObject({ status: "changed", change: { schema: { rowCountAfter: 5 } } });
    const again = await other.backend.reloadDataset(meta.id);
    expect(again.status).toBe("ok");
  });

  it("writes recovery snapshots with table data and restores them", async () => {
    const meta = await h.backend.importCsv(h.add("sales.csv", SALES), {});
    await h.backend.writeRecovery("proj-1", "portable", doc("Recovered"));
    await h.backend.writeRecovery("proj-1", "portable", doc("Recovered"));
    expect(await h.store.tableIds()).toEqual([meta.id]);
    const list = await h.backend.listRecovery();
    expect(list).toMatchObject([{ projectId: "proj-1", name: "Recovered", datasetCount: 1 }]);

    const fresh = await harness(h.store);
    const opened = await fresh.backend.restoreRecovery("proj-1");
    expect(opened.project).toMatchObject({ name: "Recovered" });
    expect(opened.datasets[0]).toMatchObject({ status: "ok" });
    expect((await fresh.backend.listDatasets())[0].rowCount).toBe(4);

    await fresh.backend.deleteRecovery("proj-1");
    expect(await fresh.backend.listRecovery()).toEqual([]);
    expect(await h.store.tableIds()).toEqual([]);
    await expect(fresh.backend.writeRecovery("../x", "portable", doc())).rejects.toMatchObject({ kind: "internal" });
  });

  it("never fetches remote files or extensions", async () => {
    const db = await openNodeDb();
    await expect(db.query("SELECT * FROM read_csv_auto('https://example.com/x.csv')")).rejects.toBeTruthy();
    const setting = async (name: string) =>
      (await db.query(`SELECT current_setting('${name}')`)).rows[0][0];
    expect(await setting("autoload_known_extensions")).toBe(false);
    expect(await setting("custom_extension_repository")).toMatch(/^file:/);
    await expect(db.query("SET autoload_known_extensions = true")).rejects.toMatchObject({
      message: expect.stringMatching(/locked/),
    });
  });
});
