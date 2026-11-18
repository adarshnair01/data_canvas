/** Schema detection, type-override views, preview and column stats; a port of `db/schema.rs`. */

import type { CellValue, ColumnInfo, ColumnStats, LogicalType, PreviewPage, ValueCount } from "@/types/dataset";
import type { SortDir } from "@/types/query";
import { scalar, type Db } from "./db";
import { appError } from "./errors";
import { quoteIdent, tableName, viewName } from "./ident";

export const PREVIEW_PAGE_CAP = 1000;
export const DISTINCT_CAP = 500;

export function logicalFromDuckType(t: string): LogicalType {
  const base = t.trim().toUpperCase().split("(")[0].trim();
  switch (base) {
    case "TINYINT":
    case "SMALLINT":
    case "INTEGER":
    case "INT":
    case "BIGINT":
    case "HUGEINT":
    case "UTINYINT":
    case "USMALLINT":
    case "UINTEGER":
    case "UBIGINT":
    case "UHUGEINT":
      return "integer";
    case "FLOAT":
    case "REAL":
    case "DOUBLE":
    case "DECIMAL":
    case "NUMERIC":
      return "float";
    case "BOOLEAN":
    case "BOOL":
      return "boolean";
    case "DATE":
      return "date";
    case "VARCHAR":
    case "TEXT":
    case "STRING":
    case "UUID":
      return "string";
    default:
      return base.startsWith("TIMESTAMP") ? "timestamp" : "other";
  }
}

const CAST_TARGET: Partial<Record<LogicalType, string>> = {
  string: "VARCHAR",
  integer: "BIGINT",
  float: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE",
  timestamp: "TIMESTAMP",
};

export async function describe(db: Db, relation: string): Promise<[string, string][]> {
  const r = await db.query(`DESCRIBE SELECT * FROM ${quoteIdent(relation)}`);
  return r.rows.map((row) => [String(row[0]), String(row[1])]);
}

export async function createView(db: Db, id: string, overrides: Record<string, LogicalType>): Promise<void> {
  const table = tableName(id);
  const base = await describe(db, table);
  for (const name of Object.keys(overrides)) {
    if (!base.some(([n]) => n === name)) throw appError("unknownColumn", name);
  }
  const select = base
    .map(([name]) => {
      const q = quoteIdent(name);
      const target = CAST_TARGET[overrides[name]];
      return target ? `TRY_CAST(${q} AS ${target}) AS ${q}` : q;
    })
    .join(", ");
  await db.query(`CREATE OR REPLACE VIEW ${quoteIdent(viewName(id))} AS SELECT ${select} FROM ${quoteIdent(table)}`);
}

export async function detectSchema(
  db: Db,
  id: string,
  overrides: Record<string, LogicalType>,
): Promise<{ columns: ColumnInfo[]; rowCount: number }> {
  const original = new Map(await describe(db, tableName(id)));
  const cols = await describe(db, viewName(id));
  if (!cols.length) throw appError("emptyFile");
  const exprs = ["count(*)"];
  for (const [name] of cols) {
    const q = quoteIdent(name);
    exprs.push(`count(*) - count(${q})`, `approx_count_distinct(${q})`);
  }
  const r = await db.query(`SELECT ${exprs.join(", ")} FROM ${quoteIdent(viewName(id))}`);
  const stats = r.rows[0].map(Number);
  const columns = cols.map(([name, duckType], i): ColumnInfo => {
    const info: ColumnInfo = {
      name,
      logicalType: logicalFromDuckType(duckType),
      duckType,
      nullCount: stats[1 + i * 2],
      distinctEstimate: stats[2 + i * 2],
    };
    if (name in overrides && original.has(name)) info.originalType = original.get(name);
    return info;
  });
  return { columns, rowCount: stats[0] };
}

export async function preview(
  db: Db,
  id: string,
  columns: ColumnInfo[],
  totalRows: number,
  offset: number,
  limit: number,
  sort?: { column: string; dir: SortDir } | null,
): Promise<PreviewPage> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), PREVIEW_PAGE_CAP);
  const off = Math.max(0, Math.trunc(offset));
  let order = "";
  if (sort) {
    if (!columns.some((c) => c.name === sort.column)) throw appError("unknownColumn", sort.column);
    order = ` ORDER BY ${quoteIdent(sort.column)} ${sort.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`;
  }
  const r = await db.query(`SELECT * FROM ${quoteIdent(viewName(id))}${order} LIMIT ${lim} OFFSET ${off}`);
  return { columns: columns.map((c) => c.name), rows: r.rows, offset: off, totalRows };
}

export async function distinctValues(
  db: Db,
  id: string,
  column: ColumnInfo,
  search: string | null | undefined,
  limit: number,
): Promise<ValueCount[]> {
  const view = quoteIdent(viewName(id));
  const q = quoteIdent(column.name);
  const lim = Math.min(Math.max(Math.trunc(limit), 1), DISTINCT_CAP);
  const params = search ? [search] : [];
  const filter = search ? ` WHERE contains(lower(CAST(${q} AS VARCHAR)), lower(?))` : "";
  const r = await db.query(
    `SELECT ${q} AS v, count(*) AS n FROM ${view}${filter} GROUP BY 1 ORDER BY n DESC, v ASC NULLS LAST LIMIT ${lim}`,
    params,
  );
  return r.rows.map((row) => ({ value: row[0], count: Number(row[1]) }));
}

export async function columnStats(db: Db, id: string, column: ColumnInfo): Promise<ColumnStats> {
  const view = quoteIdent(viewName(id));
  const q = quoteIdent(column.name);
  const numeric = column.logicalType === "integer" || column.logicalType === "float";
  const mean = numeric ? `avg(${q})::DOUBLE` : "NULL::DOUBLE";
  const r = await db.query(
    `SELECT count(*), count(*) - count(${q}), approx_count_distinct(${q}), min(${q}), max(${q}), ${mean} FROM ${view}`,
  );
  const [rowCount, nullCount, distinctCount, min, max, m] = r.rows[0];
  return {
    column: column.name,
    logicalType: column.logicalType,
    rowCount: Number(rowCount),
    nullCount: Number(nullCount),
    distinctCount: Number(distinctCount),
    min: min as CellValue,
    max: max as CellValue,
    mean: typeof m === "number" ? m : null,
    topValues: await distinctValues(db, id, column, null, 10),
  };
}

export async function rowCount(db: Db, table: string): Promise<number> {
  return Number(await scalar(db, `SELECT count(*) FROM ${quoteIdent(table)}`));
}
