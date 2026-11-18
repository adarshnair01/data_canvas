import { defaultChartConfig, emptyEncoding, type ChartType, type FieldRef } from "@/types/chart";
import type { DatasetMeta } from "@/types/dataset";
import type { Widget } from "@/types/project";

export const sales: DatasetMeta = {
  id: "ds1",
  name: "Sales",
  source: { kind: "csv", path: "/tmp/sales.csv", header: true },
  columns: [
    { name: "region", logicalType: "string", duckType: "VARCHAR", nullCount: 0, distinctEstimate: 4 },
    { name: "product", logicalType: "string", duckType: "VARCHAR", nullCount: 0, distinctEstimate: 5 },
    { name: "order_date", logicalType: "date", duckType: "DATE", nullCount: 0, distinctEstimate: 300 },
    { name: "revenue", logicalType: "float", duckType: "DOUBLE", nullCount: 0, distinctEstimate: 500 },
    { name: "units", logicalType: "integer", duckType: "BIGINT", nullCount: 0, distinctEstimate: 20 },
  ],
  rowCount: 600,
  fingerprint: { path: "/tmp/sales.csv", size: 1, modifiedMs: 0, partialSha256: "x" },
  typeOverrides: {},
  importedAt: "2026-01-01T00:00:00Z",
};

export const col = (field: string, id: string, extra: Partial<FieldRef> = {}): FieldRef => ({
  id,
  source: "column",
  field,
  agg: "none",
  ...extra,
});

export function widget(chartType: ChartType, encoding: Partial<Widget["encoding"]> = {}, extra: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    datasetId: sales.id,
    chartType,
    encoding: { ...emptyEncoding(), ...encoding },
    config: defaultChartConfig(),
    filters: [],
    sort: [],
    ...extra,
  };
}
