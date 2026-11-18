/**
 * `QuerySpec` -> parameterised SQL: a port of `src-tauri/src/db/query_builder.rs`. Every
 * identifier is validated against the schema and quoted; every user value is bound.
 */

import type { CellValue, ColumnInfo, LogicalType } from "@/types/dataset";
import type { Aggregation, Dimension, Filter, Measure, QueryMode, QuerySpec } from "@/types/query";
import { CHART_ROW_CAP } from "@/types/query";
import { appError, queryError } from "./errors";
import { compileExpression, parseExpression } from "./expr";
import { quoteIdent, validateAlias, viewName } from "./ident";
import type { SqlParam } from "./sql";

const MAX_IN_VALUES = 1000;
const MAX_OFFSET = 100_000_000;
const U32_MAX = 4_294_967_295;

export interface OutputColumn {
  id: string;
  role: "dimension" | "measure";
}

export interface BuiltQuery {
  sql: string;
  params: SqlParam[];
  columns: OutputColumn[];
  /** Rows to keep; the SQL fetches one more to detect truncation when capped. */
  limit: number;
}

const AGGS: Aggregation[] = ["sum", "avg", "count", "count_distinct", "min", "max", "none"];
const BUCKETS = ["day", "week", "month", "quarter", "year"];
const MODES: QueryMode[] = ["aggregate", "raw"];

/** Rust `{:?}` of the enum variant, used in a few error messages. */
const debugName = (s: string) =>
  s
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");

const isNumeric = (t: LogicalType) => t === "integer" || t === "float";
const isTemporal = (t: LogicalType) => t === "date" || t === "timestamp";

/** What serde rejects before the Rust builder ever runs (unknown enum variants, bad numbers). */
function checkShape(spec: QuerySpec) {
  const variant = (v: unknown, allowed: readonly string[], what: string) => {
    if (typeof v !== "string" || !allowed.includes(v)) throw queryError(`unknown ${what} variant ${JSON.stringify(v)}`);
  };
  const u32 = (v: unknown, what: string) => {
    if (v != null && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= U32_MAX)) {
      throw queryError(`invalid ${what}`);
    }
  };
  if (spec.mode != null) variant(spec.mode, MODES, "mode");
  for (const d of spec.dimensions ?? []) if (d.bucket != null) variant(d.bucket, BUCKETS, "bucket");
  for (const m of spec.measures ?? []) {
    variant(m.agg, AGGS, "aggregation");
    variant(m.source?.type, ["column", "rows", "expression"], "measure source");
  }
  for (const f of spec.filters ?? []) variant(f.kind, ["in", "range", "dateRange", "contains"], "filter");
  for (const s of spec.sort ?? []) variant(s.dir, ["asc", "desc"], "sort direction");
  u32(spec.limit, "limit");
  u32(spec.offset, "offset");
}

function findColumn(schema: ColumnInfo[], field: string): ColumnInfo {
  const c = schema.find((c) => c.name === field);
  if (!c) throw appError("unknownColumn", field);
  return c;
}

function dimensionSql(d: Dimension, schema: ColumnInfo[]): string {
  const col = findColumn(schema, d.field);
  const q = quoteIdent(col.name);
  if (!d.bucket) return q;
  if (!isTemporal(col.logicalType)) {
    throw queryError(`date bucketing requires a date column, '${col.name}' is ${debugName(col.logicalType)}`);
  }
  return `CAST(date_trunc('${d.bucket}', ${q}) AS DATE)`;
}

function aggSql(agg: Aggregation, inner: string): string {
  switch (agg) {
    case "count_distinct":
      return `count(DISTINCT ${inner})`;
    case "none":
      return inner;
    default:
      return `${agg}(${inner})`;
  }
}

function measureSql(m: Measure, mode: QueryMode, schema: ColumnInfo[], params: SqlParam[]): string {
  const src = m.source;
  if (src.type === "rows") {
    if (mode === "aggregate") return "count(*)";
    throw queryError("row count measures require aggregate mode");
  }
  if (src.type === "column") {
    const col = findColumn(schema, src.column);
    const q = quoteIdent(col.name);
    if (mode === "aggregate" && m.agg === "none") throw queryError(`measure '${col.name}' needs an aggregation`);
    if (mode === "raw") {
      if (m.agg === "none") return q;
      throw queryError("aggregations are not allowed in raw mode");
    }
    if ((m.agg === "sum" || m.agg === "avg") && !isNumeric(col.logicalType)) {
      throw queryError(`cannot ${debugName(m.agg)} non-numeric column '${col.name}'`);
    }
    return aggSql(m.agg, q);
  }
  const parsed = parseExpression(src.expression, schema);
  const sql = compileExpression(parsed.ast, params);
  if (parsed.isAggregate) {
    if (mode === "aggregate" && m.agg === "none") return sql;
    if (mode === "raw") throw queryError("aggregate expressions are not allowed in raw mode");
    throw queryError("expression already aggregates; set aggregation to none");
  }
  if (mode === "aggregate") {
    if (m.agg === "none") throw queryError("row-level expression needs an aggregation");
    return aggSql(m.agg, sql);
  }
  if (m.agg === "none") return sql;
  throw queryError("aggregations are not allowed in raw mode");
}

const jsonText = (v: unknown) => JSON.stringify(v);

function jsonParam(v: CellValue, col: ColumnInfo): SqlParam {
  const t = col.logicalType;
  const bad = () => queryError(`invalid filter value ${jsonText(v)} for column '${col.name}'`);
  if (isNumeric(t) && typeof v === "number") return Number.isInteger(v) ? { int: v } : { float: v };
  if (isNumeric(t) && typeof v === "string") {
    const s = v.trim();
    if (/^[+-]?\d+$/.test(s) && Number.isSafeInteger(Number(s))) return { int: Number(s) };
    const f = Number(s);
    if (s === "" || Number.isNaN(f)) throw bad();
    return { float: f };
  }
  if (t === "boolean" && typeof v === "boolean") return { bool: v };
  if (t === "boolean" && typeof v === "string") {
    if (v === "true") return { bool: true };
    if (v === "false") return { bool: false };
    throw bad();
  }
  if (typeof v === "string") return { text: v };
  if (typeof v === "number" || typeof v === "boolean") return { text: String(v) };
  throw bad();
}

function parseDate(s: string): string {
  const head = s.slice(0, 10);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(head);
  const bad = () => queryError(`invalid date '${s}', expected YYYY-MM-DD`);
  if (!m) throw bad();
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) throw bad();
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function filterSql(f: Filter, schema: ColumnInfo[], params: SqlParam[]): string | null {
  switch (f.kind) {
    case "in": {
      const col = findColumn(schema, f.field);
      const values = f.values ?? [];
      if (!values.length) return null;
      if (values.length > MAX_IN_VALUES) throw queryError("too many filter values");
      const asText = isTemporal(col.logicalType) || col.logicalType === "other";
      const q = quoteIdent(col.name);
      const target = asText ? `CAST(${q} AS VARCHAR)` : q;
      const hasNull = values.some((v) => v === null);
      const placeholders: string[] = [];
      for (const v of values) {
        if (v === null) continue;
        params.push(asText ? { text: typeof v === "string" ? v : jsonText(v) } : jsonParam(v, col));
        placeholders.push("?");
      }
      const parts: string[] = [];
      if (placeholders.length) parts.push(`${target} IN (${placeholders.join(", ")})`);
      if (hasNull) parts.push(`${q} IS NULL`);
      const cond = `(${parts.join(" OR ")})`;
      if (!f.exclude) return cond;
      return hasNull ? `(NOT ${cond})` : `(NOT ${cond} OR ${q} IS NULL)`;
    }
    case "range": {
      const col = findColumn(schema, f.field);
      if (!isNumeric(col.logicalType)) throw queryError(`numeric range filter on non-numeric column '${col.name}'`);
      const q = quoteIdent(col.name);
      const parts: string[] = [];
      for (const [bound, op] of [
        [f.min, ">="],
        [f.max, "<="],
      ] as const) {
        if (bound == null) continue;
        if (!Number.isFinite(bound)) throw queryError("range bounds must be finite");
        params.push({ float: bound });
        parts.push(`${q} ${op} ?`);
      }
      return parts.length ? `(${parts.join(" AND ")})` : null;
    }
    case "dateRange": {
      const col = findColumn(schema, f.field);
      if (!isTemporal(col.logicalType)) throw queryError(`date range filter on non-date column '${col.name}'`);
      const q = quoteIdent(col.name);
      const parts: string[] = [];
      if (f.from) {
        params.push({ text: parseDate(f.from) });
        parts.push(`${q} >= CAST(? AS DATE)`);
      }
      if (f.to) {
        params.push({ text: parseDate(f.to) });
        parts.push(`${q} < CAST(? AS DATE) + INTERVAL 1 DAY`);
      }
      return parts.length ? `(${parts.join(" AND ")})` : null;
    }
    case "contains": {
      const col = findColumn(schema, f.field);
      if (!f.text) return null;
      params.push({ text: f.text });
      return `contains(lower(CAST(${quoteIdent(col.name)} AS VARCHAR)), lower(?))`;
    }
  }
}

export function buildQuery(spec: QuerySpec, schema: ColumnInfo[]): BuiltQuery {
  return build(spec, schema, CHART_ROW_CAP);
}

/** No chart row cap (CSV export); an explicit `spec.limit` is still honoured. */
export function buildExportQuery(spec: QuerySpec, schema: ColumnInfo[]): BuiltQuery {
  return build(spec, schema, null);
}

function build(spec: QuerySpec, schema: ColumnInfo[], cap: number | null): BuiltQuery {
  checkShape(spec);
  const relation = quoteIdent(viewName(spec.datasetId));
  const mode = spec.mode ?? "aggregate";
  const dimensions = spec.dimensions ?? [];
  const measures = spec.measures ?? [];
  if (!dimensions.length && !measures.length) throw queryError("select at least one field");

  const ids = new Set<string>();
  const columns: OutputColumn[] = [];
  const select: string[] = [];
  const groupBy: string[] = [];
  const params: SqlParam[] = [];

  for (const d of dimensions) {
    validateAlias(d.id);
    if (ids.has(d.id)) throw queryError(`duplicate id '${d.id}'`);
    ids.add(d.id);
    const sql = dimensionSql(d, schema);
    select.push(`${sql} AS ${quoteIdent(d.id)}`);
    groupBy.push(sql);
    columns.push({ id: d.id, role: "dimension" });
  }
  for (const m of measures) {
    validateAlias(m.id);
    if (ids.has(m.id)) throw queryError(`duplicate id '${m.id}'`);
    ids.add(m.id);
    select.push(`${measureSql(m, mode, schema, params)} AS ${quoteIdent(m.id)}`);
    columns.push({ id: m.id, role: "measure" });
  }

  const wheres: string[] = [];
  for (const f of spec.filters ?? []) {
    const w = filterSql(f, schema, params);
    if (w) wheres.push(w);
  }

  const order: string[] = [];
  for (const s of spec.sort ?? []) {
    if (!ids.has(s.by)) throw queryError(`sort references unknown id '${s.by}'`);
    order.push(`${quoteIdent(s.by)} ${s.dir.toUpperCase()} NULLS LAST`);
  }
  if (!order.length) {
    const d = dimensions.find((d) => d.bucket);
    if (d) order.push(`${quoteIdent(d.id)} ASC NULLS LAST`);
  }

  const offset = Math.min(spec.offset ?? 0, MAX_OFFSET);
  let sql = `SELECT ${select.join(", ")} FROM ${relation}`;
  if (wheres.length) sql += ` WHERE ${wheres.join(" AND ")}`;
  if (mode === "aggregate" && groupBy.length) sql += ` GROUP BY ${groupBy.join(", ")}`;
  if (order.length) sql += ` ORDER BY ${order.join(", ")}`;

  let limit: number;
  if (cap != null) {
    limit = Math.min(Math.max(spec.limit ?? cap, 1), cap);
    sql += ` LIMIT ${limit + 1} OFFSET ${offset}`;
  } else {
    if (spec.limit != null) sql += ` LIMIT ${Math.max(spec.limit, 1)}`;
    if (offset > 0) sql += ` OFFSET ${offset}`;
    limit = spec.limit != null ? Math.max(spec.limit, 1) : Number.MAX_SAFE_INTEGER;
  }
  return { sql, params, columns, limit };
}
