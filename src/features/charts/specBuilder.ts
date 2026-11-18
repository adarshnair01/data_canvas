/** Widget (+ dashboard filters + metrics) -> QuerySpec. Pure; no SQL is produced here. */

import type { FieldRef } from "@/types/chart";
import { isNumericType, isTemporalType, type DatasetMeta } from "@/types/dataset";
import type { CalculatedMetric } from "@/types/metrics";
import type { GlobalFilter, Widget } from "@/types/project";
import type { Dimension, Filter, Measure, QueryMode, QuerySpec, SortSpec } from "@/types/query";

export type SpecResult = { ok: true; spec: QuerySpec } | { ok: false; reason: string };

export function globalFilterToFilter(g: GlobalFilter): Filter | null {
  switch (g.kind) {
    case "in":
      return g.values.length ? { kind: "in", field: g.field, values: g.values } : null;
    case "range":
      return g.min == null && g.max == null
        ? null
        : { kind: "range", field: g.field, min: g.min ?? null, max: g.max ?? null };
    case "dateRange":
      return !g.from && !g.to
        ? null
        : { kind: "dateRange", field: g.field, from: g.from || null, to: g.to || null };
  }
}

/** Global filters apply when the widget's dataset has the column (and the dataset matches, if pinned). */
export function applicableGlobalFilters(dataset: DatasetMeta, filters: GlobalFilter[]): Filter[] {
  return filters
    .filter((g) => (g.datasetId == null || g.datasetId === dataset.id) && !!dataset.columns.find((c) => c.name === g.field))
    .filter((g) => {
      const col = dataset.columns.find((c) => c.name === g.field)!;
      if (g.kind === "range") return isNumericType(col.logicalType);
      if (g.kind === "dateRange") return isTemporalType(col.logicalType);
      return true;
    })
    .map(globalFilterToFilter)
    .filter((f): f is Filter => f !== null);
}

function metricFor(ref: FieldRef, metrics: CalculatedMetric[]) {
  return ref.source === "metric" ? metrics.find((m) => m.id === ref.field) : undefined;
}

export function refLabel(ref: FieldRef, metrics: CalculatedMetric[] = []): string {
  if (ref.label) return ref.label;
  if (ref.source === "rows") return "Row count";
  const base = ref.source === "metric" ? (metricFor(ref, metrics)?.name ?? "Metric") : ref.field;
  if (ref.bucket) return `${base} (${ref.bucket})`;
  if (ref.source === "metric" && metricFor(ref, metrics)?.isAggregate) return base;
  if (ref.agg && ref.agg !== "none") return `${aggLabel(ref.agg)} of ${base}`;
  return base;
}

export function aggLabel(agg: FieldRef["agg"]): string {
  return {
    sum: "Sum",
    avg: "Average",
    count: "Count",
    count_distinct: "Distinct count",
    min: "Min",
    max: "Max",
    none: "Value",
  }[agg];
}

class SpecError extends Error {}

function toDimension(ref: FieldRef, dataset: DatasetMeta): Dimension {
  if (ref.source !== "column") throw new SpecError(`${refLabel(ref)} cannot be used as a category`);
  const col = dataset.columns.find((c) => c.name === ref.field);
  if (!col) throw new SpecError(`Column "${ref.field}" is not in ${dataset.name}`);
  const bucket = ref.bucket && isTemporalType(col.logicalType) ? ref.bucket : undefined;
  return bucket ? { id: ref.id, field: ref.field, bucket } : { id: ref.id, field: ref.field };
}

function toMeasure(
  ref: FieldRef,
  mode: QueryMode,
  dataset: DatasetMeta,
  metrics: CalculatedMetric[],
): Measure {
  if (ref.source === "rows") {
    if (mode === "raw") throw new SpecError("Row count needs aggregated data");
    return { id: ref.id, source: { type: "rows" }, agg: "count" };
  }
  if (ref.source === "metric") {
    const m = metricFor(ref, metrics);
    if (!m) throw new SpecError("Calculated metric no longer exists");
    if (m.datasetId !== dataset.id) throw new SpecError(`Metric "${m.name}" belongs to another dataset`);
    if (mode === "raw") {
      if (m.isAggregate) throw new SpecError(`"${m.name}" aggregates rows and cannot be plotted per row`);
      return { id: ref.id, source: { type: "expression", expression: m.expression }, agg: "none" };
    }
    const agg = m.isAggregate ? "none" : ref.agg === "none" ? "sum" : ref.agg;
    return { id: ref.id, source: { type: "expression", expression: m.expression }, agg };
  }
  const col = dataset.columns.find((c) => c.name === ref.field);
  if (!col) throw new SpecError(`Column "${ref.field}" is not in ${dataset.name}`);
  if (mode === "raw") return { id: ref.id, source: { type: "column", column: ref.field }, agg: "none" };
  let agg = ref.agg === "none" ? (isNumericType(col.logicalType) ? "sum" : "count") : ref.agg;
  if ((agg === "sum" || agg === "avg") && !isNumericType(col.logicalType)) agg = "count";
  return { id: ref.id, source: { type: "column", column: ref.field }, agg };
}

/** A table column is aggregated if it is a row count, an aggregate metric, or has an aggregation set. */
function isAggregatedRef(ref: FieldRef, metrics: CalculatedMetric[]): boolean {
  if (ref.source === "rows") return true;
  if (ref.source === "metric") return !!metricFor(ref, metrics)?.isAggregate || ref.agg !== "none";
  return ref.agg !== "none";
}

export function buildQuerySpec(
  widget: Widget,
  dataset: DatasetMeta | undefined,
  metrics: CalculatedMetric[],
  globalFilters: GlobalFilter[],
): SpecResult {
  if (!widget.datasetId || !dataset) return { ok: false, reason: "Choose a dataset" };
  const e = widget.encoding;
  const filters = [...widget.filters, ...applicableGlobalFilters(dataset, globalFilters)];
  let mode: QueryMode = "aggregate";
  let dimensions: Dimension[] = [];
  let measures: Measure[] = [];
  let defaultSort: SortSpec[] = [];

  try {
    switch (widget.chartType) {
      case "bar":
      case "line":
      case "area": {
        if (!e.x) return { ok: false, reason: "Add a field to the X axis" };
        if (!e.y.length) return { ok: false, reason: "Add a measure to the Y axis" };
        const x = toDimension(e.x, dataset);
        dimensions = [x];
        if (e.color) {
          dimensions.push(toDimension(e.color, dataset));
          measures = [toMeasure(e.y[0], mode, dataset, metrics)];
        } else {
          measures = e.y.map((r) => toMeasure(r, mode, dataset, metrics));
        }
        const xCol = dataset.columns.find((c) => c.name === x.field);
        const ordered = widget.chartType !== "bar" || !!e.color || !!x.bucket || (xCol && isTemporalType(xCol.logicalType));
        defaultSort = ordered ? [{ by: x.id, dir: "asc" }] : [{ by: measures[0].id, dir: "desc" }];
        break;
      }
      case "pie": {
        if (!e.color) return { ok: false, reason: "Add a field to Slices" };
        if (!e.value) return { ok: false, reason: "Add a measure to Value" };
        dimensions = [toDimension(e.color, dataset)];
        measures = [toMeasure(e.value, mode, dataset, metrics)];
        defaultSort = [{ by: measures[0].id, dir: "desc" }];
        break;
      }
      case "scatter": {
        if (!e.x || !e.y[0]) return { ok: false, reason: "Add measures to X and Y" };
        mode = "raw";
        if (e.color) dimensions = [toDimension(e.color, dataset)];
        measures = [e.x, e.y[0], e.size]
          .filter((r): r is FieldRef => !!r)
          .map((r) => toMeasure(r, mode, dataset, metrics));
        break;
      }
      case "kpi": {
        if (!e.value) return { ok: false, reason: "Add a measure to Value" };
        measures = [toMeasure(e.value, mode, dataset, metrics)];
        break;
      }
      case "table": {
        if (!e.columns.length) return { ok: false, reason: "Add columns to the table" };
        const aggregated = e.columns.some((r) => isAggregatedRef(r, metrics));
        mode = aggregated ? "aggregate" : "raw";
        for (const r of e.columns) {
          if (r.source === "column" && (!aggregated || r.agg === "none")) dimensions.push(toDimension(r, dataset));
          else measures.push(toMeasure(r, mode, dataset, metrics));
        }
        break;
      }
    }
  } catch (err) {
    if (err instanceof SpecError) return { ok: false, reason: err.message };
    throw err;
  }

  const ids = new Set([...dimensions, ...measures].map((x) => x.id));
  const userSort = widget.sort.filter((s) => ids.has(s.by));
  const spec: QuerySpec = {
    datasetId: dataset.id,
    mode,
    dimensions,
    measures,
    filters,
    sort: userSort.length ? userSort : defaultSort,
  };
  if (widget.limit) spec.limit = widget.limit;
  if (widget.chartType === "kpi") spec.limit = 1;
  return { ok: true, spec };
}
