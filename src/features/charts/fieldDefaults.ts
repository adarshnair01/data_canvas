import { ZONES_BY_CHART, type ChartType, type DropZoneId, type FieldRef, type ZoneDef } from "@/types/chart";
import { isNumericType, isTemporalType, type DatasetMeta } from "@/types/dataset";
import type { CalculatedMetric } from "@/types/metrics";

export type DragItem =
  | { kind: "column"; name: string }
  | { kind: "metric"; id: string }
  | { kind: "rows" };

export const dragItemId = (d: DragItem) =>
  d.kind === "column" ? `col:${d.name}` : d.kind === "metric" ? `metric:${d.id}` : "rows";

function isMeasureLike(item: DragItem, dataset: DatasetMeta): boolean {
  if (item.kind !== "column") return true;
  const c = dataset.columns.find((x) => x.name === item.name);
  return !!c && isNumericType(c.logicalType);
}

/** Whether a dragged field can go in a zone (metrics/row count are never categories). */
export function zoneAccepts(zone: ZoneDef, item: DragItem): boolean {
  if (zone.accepts === "dimension") return item.kind === "column";
  return true;
}

/** Sensible aggregation / bucketing for a field dropped into a zone. */
export function defaultRefFor(
  zoneId: DropZoneId,
  item: DragItem,
  chartType: ChartType,
  dataset: DatasetMeta,
  metrics: CalculatedMetric[],
): Omit<FieldRef, "id"> | null {
  const zone = ZONES_BY_CHART[chartType].find((z) => z.id === zoneId);
  if (!zone || !zoneAccepts(zone, item)) return null;
  const raw = chartType === "scatter" && zone.accepts === "measure";

  if (item.kind === "rows") return raw ? null : { source: "rows", field: "", agg: "count" };
  if (item.kind === "metric") {
    const m = metrics.find((x) => x.id === item.id);
    if (!m || (raw && m.isAggregate)) return null;
    return { source: "metric", field: m.id, agg: m.isAggregate || raw ? "none" : "sum" };
  }

  const col = dataset.columns.find((c) => c.name === item.name);
  if (!col) return null;
  const numeric = isNumericType(col.logicalType);
  const temporal = isTemporalType(col.logicalType);

  if (zone.accepts === "dimension" || (zone.accepts === "any" && !numeric)) {
    return { source: "column", field: col.name, agg: "none", bucket: temporal && zone.id === "x" ? "month" : undefined };
  }
  if (raw && !numeric) return null;
  if (raw || zone.accepts === "any") return { source: "column", field: col.name, agg: "none" };
  return { source: "column", field: col.name, agg: numeric ? "sum" : "count" };
}

/** Zone a field goes to when clicked instead of dragged. */
export function autoZone(chartType: ChartType, item: DragItem, dataset: DatasetMeta, filled: Set<DropZoneId>): DropZoneId | null {
  const zones = ZONES_BY_CHART[chartType];
  const wantsMeasure = isMeasureLike(item, dataset);
  const fits = (z: ZoneDef) =>
    zoneAccepts(z, item) &&
    (z.accepts === "any" || (wantsMeasure ? z.accepts === "measure" : z.accepts === "dimension"));
  return (
    zones.find((z) => fits(z) && (z.multiple || !filled.has(z.id)))?.id ??
    zones.find((z) => fits(z))?.id ??
    null
  );
}
