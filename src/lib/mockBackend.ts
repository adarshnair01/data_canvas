/**
 * Dev-only stand-in for the Rust backend so the UI can be previewed in a plain browser
 * (`pnpm dev`). Never bundled into production builds (gated on `import.meta.env.DEV`).
 */

import type { CellValue, ColumnInfo, DatasetMeta, LogicalType } from "@/types/dataset";
import type { Filter, Measure, QueryResult, QuerySpec } from "@/types/query";
import type { RecentProject } from "./ipc";

type Row = Record<string, CellValue>;

const regions = ["North", "South", "East", "West"];
const products = ["Widgets", "Gadgets", "Gizmos", "Doohickeys", "Sprockets"];

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function makeRows(): Row[] {
  const rand = seeded(42);
  const rows: Row[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 600; i++) {
    const d = new Date(start + Math.floor(rand() * 365) * 86400000);
    const units = 1 + Math.floor(rand() * 20);
    const price = Math.round((5 + rand() * 45) * 100) / 100;
    rows.push({
      order_date: d.toISOString().slice(0, 10),
      region: regions[Math.floor(rand() * regions.length)],
      product: products[Math.floor(rand() * products.length)],
      units,
      unit_price: price,
      revenue: Math.round(units * price * 100) / 100,
    });
  }
  return rows;
}

const types: Record<string, LogicalType> = {
  order_date: "date",
  region: "string",
  product: "string",
  units: "integer",
  unit_price: "float",
  revenue: "float",
};

const tables = new Map<string, Row[]>();
const datasets = new Map<string, DatasetMeta>();
const savedProjects = new Map<string, { mode: string; project: unknown }>();
let recent: RecentProject[] = [
  { path: "/Users/demo/Q3 Review.datacanvas", name: "Q3 Review", lastOpenedMs: Date.now() - 3600e3 },
  { path: "/Users/demo/Marketing.datacanvas", name: "Marketing", lastOpenedMs: Date.now() - 86400e3 },
];

function columnsFor(rows: Row[]): ColumnInfo[] {
  return Object.keys(types).map((name) => ({
    name,
    logicalType: types[name],
    duckType: { string: "VARCHAR", integer: "BIGINT", float: "DOUBLE", date: "DATE" }[
      types[name] as "string"
    ],
    nullCount: rows.filter((r) => r[name] === null).length,
    distinctEstimate: new Set(rows.map((r) => r[name])).size,
  }));
}

function addDataset(name: string, path: string): DatasetMeta {
  const id = Math.random().toString(16).slice(2, 18).padEnd(16, "0");
  const rows = makeRows();
  tables.set(id, rows);
  const meta: DatasetMeta = {
    id,
    name,
    source: { kind: path.endsWith(".xlsx") ? "xlsx" : "csv", path, header: true },
    columns: columnsFor(rows),
    rowCount: rows.length,
    fingerprint: { path, size: 48213, modifiedMs: Date.now(), partialSha256: "0".repeat(64) },
    typeOverrides: {},
    importedAt: new Date().toISOString(),
  };
  datasets.set(id, meta);
  return meta;
}

addDataset("Sample Sales", "/Users/demo/sales.csv");

function bucket(v: CellValue, b?: string): CellValue {
  if (typeof v !== "string" || !b) return v;
  const d = new Date(v + "T00:00:00Z");
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (b) {
    case "year":
      return `${y}-01-01`;
    case "quarter":
      return `${y}-${pad(Math.floor(m / 3) * 3 + 1)}-01`;
    case "month":
      return `${y}-${pad(m + 1)}-01`;
    case "week": {
      const day = (d.getUTCDay() + 6) % 7;
      return new Date(d.getTime() - day * 86400000).toISOString().slice(0, 10);
    }
    default:
      return v;
  }
}

function passes(r: Row, f: Filter): boolean {
  const v = r[f.field];
  switch (f.kind) {
    case "in": {
      if (!f.values.length) return true;
      const hit = f.values.some((x) => String(x) === String(v));
      return f.exclude ? !hit : hit;
    }
    case "range":
      return (f.min == null || Number(v) >= f.min) && (f.max == null || Number(v) <= f.max);
    case "dateRange":
      return (!f.from || String(v) >= f.from) && (!f.to || String(v) <= f.to);
    case "contains":
      return String(v).toLowerCase().includes(f.text.toLowerCase());
  }
}

function aggregate(rows: Row[], m: Measure): CellValue {
  if (m.source.type === "rows") return rows.length;
  if (m.source.type === "expression") {
    const sum = rows.reduce((a, r) => a + Number(r.revenue ?? 0), 0);
    return Math.round(sum / Math.max(rows.length, 1));
  }
  const col = m.source.column;
  const vals = rows.map((r) => r[col]).filter((v) => v !== null);
  const nums = vals.map(Number);
  switch (m.agg) {
    case "sum":
      return Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
    case "avg":
      return Math.round((nums.reduce((a, b) => a + b, 0) / Math.max(nums.length, 1)) * 100) / 100;
    case "count":
      return vals.length;
    case "count_distinct":
      return new Set(vals.map(String)).size;
    case "min":
      return vals.reduce((a, b) => ((b as number) < (a as number) ? b : a), vals[0] ?? null);
    case "max":
      return vals.reduce((a, b) => ((b as number) > (a as number) ? b : a), vals[0] ?? null);
    default:
      return vals[0] ?? null;
  }
}

function runQuery(spec: QuerySpec): QueryResult {
  const meta = datasets.get(spec.datasetId);
  if (!meta) throw { kind: "unknownDataset", message: `Unknown dataset: ${spec.datasetId}` };
  const rows = (tables.get(spec.datasetId) ?? []).filter((r) => spec.filters.every((f) => passes(r, f)));
  const columns = [
    ...spec.dimensions.map((d) => ({ id: d.id, role: "dimension" as const })),
    ...spec.measures.map((m) => ({ id: m.id, role: "measure" as const })),
  ];
  let out: CellValue[][];
  if (spec.mode === "raw") {
    out = rows.map((r) => [
      ...spec.dimensions.map((d) => bucket(r[d.field], d.bucket)),
      ...spec.measures.map((m) =>
        m.source.type === "column" ? r[m.source.column] : Number(r.revenue ?? 0),
      ),
    ]);
  } else {
    const groups = new Map<string, { key: CellValue[]; rows: Row[] }>();
    for (const r of rows) {
      const key = spec.dimensions.map((d) => bucket(r[d.field], d.bucket));
      const k = JSON.stringify(key);
      if (!groups.has(k)) groups.set(k, { key, rows: [] });
      groups.get(k)!.rows.push(r);
    }
    if (!spec.dimensions.length && !groups.size) groups.set("[]", { key: [], rows: [] });
    out = [...groups.values()].map((g) => [...g.key, ...spec.measures.map((m) => aggregate(g.rows, m))]);
  }
  const sort = spec.sort.length
    ? spec.sort
    : spec.dimensions.filter((d) => d.bucket).map((d) => ({ by: d.id, dir: "asc" as const }));
  for (const s of [...sort].reverse()) {
    const i = columns.findIndex((c) => c.id === s.by);
    out.sort((a, b) => {
      const x = a[i] as never;
      const y = b[i] as never;
      const c = x < y ? -1 : x > y ? 1 : 0;
      return s.dir === "asc" ? c : -c;
    });
  }
  const limit = Math.min(spec.limit ?? 5000, 5000);
  const offset = spec.offset ?? 0;
  return {
    columns,
    rows: out.slice(offset, offset + limit),
    truncated: out.length > offset + limit,
    elapsedMs: 3,
  };
}

function ds(id: unknown): DatasetMeta {
  const meta = datasets.get(String(id));
  if (!meta) throw { kind: "unknownDataset", message: `Unknown dataset: ${id}` };
  return meta;
}

export async function mockInvoke<T>(cmd: string, a: Record<string, unknown> = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 40));
  const result = ((): unknown => {
    switch (cmd) {
      case "list_recent_projects":
        return recent;
      case "add_recent_project":
        recent = [
          { path: String(a.path), name: String(a.name), lastOpenedMs: Date.now() },
          ...recent.filter((r) => r.path !== a.path),
        ];
        return recent;
      case "remove_recent_project":
        recent = recent.filter((r) => r.path !== a.path);
        return recent;
      case "clear_recent_projects":
        recent = [];
        return null;
      case "get_setting":
        return localStorage.getItem(`setting:${a.key}`);
      case "set_setting":
        localStorage.setItem(`setting:${a.key}`, String(a.value));
        return null;
      case "list_datasets":
        return [...datasets.values()];
      case "get_dataset":
        return ds(a.id);
      case "import_csv":
      case "import_xlsx": {
        const path = String(a.path);
        const base = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "Dataset";
        return addDataset((a.name as string) ?? base, path);
      }
      case "list_xlsx_sheets":
        return ["Sales", "Targets"];
      case "rename_dataset": {
        const m = { ...ds(a.id), name: String(a.name) };
        datasets.set(m.id, m);
        return m;
      }
      case "remove_dataset":
        datasets.delete(String(a.id));
        return null;
      case "preview_dataset": {
        const meta = ds(a.id);
        let rows = [...(tables.get(meta.id) ?? [])];
        const sort = a.sort as { column: string; dir: string } | null;
        if (sort) {
          rows.sort((x, y) => {
            const p = x[sort.column] as never;
            const q = y[sort.column] as never;
            const c = p < q ? -1 : p > q ? 1 : 0;
            return sort.dir === "asc" ? c : -c;
          });
        }
        const offset = Number(a.offset);
        rows = rows.slice(offset, offset + Number(a.limit));
        return {
          columns: meta.columns.map((c) => c.name),
          rows: rows.map((r) => meta.columns.map((c) => r[c.name])),
          offset,
          totalRows: meta.rowCount,
        };
      }
      case "column_stats": {
        const meta = ds(a.id);
        const col = String(a.column);
        const vals = (tables.get(meta.id) ?? []).map((r) => r[col]);
        const counts = new Map<string, number>();
        vals.forEach((v) => counts.set(String(v), (counts.get(String(v)) ?? 0) + 1));
        const numeric = types[col] === "integer" || types[col] === "float";
        const sorted = [...vals].sort();
        return {
          column: col,
          logicalType: types[col],
          rowCount: vals.length,
          nullCount: 0,
          distinctCount: counts.size,
          min: numeric ? Math.min(...vals.map(Number)) : sorted[0],
          max: numeric ? Math.max(...vals.map(Number)) : sorted[sorted.length - 1],
          mean: numeric ? vals.reduce((s: number, v) => s + Number(v), 0) / vals.length : null,
          topValues: [...counts.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 10)
            .map(([value, count]) => ({ value, count })),
        };
      }
      case "distinct_values": {
        const meta = ds(a.id);
        const col = String(a.column);
        const counts = new Map<string, number>();
        for (const r of tables.get(meta.id) ?? []) {
          const v = String(r[col]);
          if (a.search && !v.toLowerCase().includes(String(a.search).toLowerCase())) continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        return [...counts.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 200)
          .map(([value, count]) => ({ value, count }));
      }
      case "set_column_types": {
        const m = { ...ds(a.id), typeOverrides: a.overrides as Record<string, LogicalType> };
        datasets.set(m.id, m);
        return m;
      }
      case "fingerprint_file":
        return { path: a.path, size: 1, modifiedMs: Date.now(), partialSha256: "0".repeat(64) };
      case "run_query":
        return runQuery(a.spec as QuerySpec);
      case "cancel_query":
        return false;
      case "parse_metric_expression": {
        const expr = String(a.expression).trim();
        if (!expr) throw { kind: "invalidExpression", message: "Invalid expression: expression is empty", position: 0 };
        if (/[;]|--/.test(expr))
          throw { kind: "invalidExpression", message: "Invalid expression: unexpected character", position: expr.search(/[;]|--/) };
        return {
          ast: { type: "null" },
          isAggregate: /\b(SUM|AVG|MIN|MAX|COUNT|COUNT_DISTINCT)\s*\(/i.test(expr),
          columns: [],
        };
      }
      case "save_project": {
        const path = String(a.path);
        savedProjects.set(path, { mode: a.mode as string, project: a.project });
        return { path, mode: a.mode, savedAt: new Date().toISOString(), datasetCount: datasets.size };
      }
      case "open_project": {
        const saved = savedProjects.get(String(a.path));
        if (!saved) throw { kind: "fileNotFound", message: `File not found: ${a.path}` };
        return {
          path: a.path,
          mode: saved.mode,
          appVersion: "0.1.0",
          migratedFrom: null,
          project: saved.project,
          datasets: [...datasets.values()].map((m) => ({ id: m.id, name: m.name, status: "ok", meta: m })),
        };
      }
      case "reload_dataset":
      case "relocate_dataset": {
        const m = ds(a.id);
        return { id: m.id, name: m.name, status: "ok", loadedFrom: "source", meta: m };
      }
      case "list_recovery":
      case "take_pending_open_files":
        return [];
      case "confirm_exit":
        return null;
      case "close_project":
      case "write_recovery":
      case "delete_recovery":
        return null;
      default:
        throw { kind: "internal", message: `mock: unsupported command ${cmd}` };
    }
  })();
  return result as T;
}
