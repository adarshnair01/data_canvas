import type { Aggregation, DateBucket } from "./query";

export type ChartType = "bar" | "line" | "area" | "pie" | "scatter" | "kpi" | "table";

export const CHART_TYPES: { type: ChartType; label: string }[] = [
  { type: "bar", label: "Bar" },
  { type: "line", label: "Line" },
  { type: "area", label: "Area" },
  { type: "pie", label: "Pie / Donut" },
  { type: "scatter", label: "Scatter" },
  { type: "kpi", label: "KPI card" },
  { type: "table", label: "Table" },
];

export type DropZoneId = "x" | "y" | "color" | "size" | "value" | "columns";

export interface ZoneDef {
  id: DropZoneId;
  label: string;
  multiple: boolean;
  /** Which kinds of field the zone expects. */
  accepts: "dimension" | "measure" | "any";
  required: boolean;
}

export const ZONES_BY_CHART: Record<ChartType, ZoneDef[]> = {
  bar: [
    { id: "x", label: "X axis", multiple: false, accepts: "dimension", required: true },
    { id: "y", label: "Y axis", multiple: true, accepts: "measure", required: true },
    { id: "color", label: "Color", multiple: false, accepts: "dimension", required: false },
  ],
  line: [
    { id: "x", label: "X axis", multiple: false, accepts: "dimension", required: true },
    { id: "y", label: "Y axis", multiple: true, accepts: "measure", required: true },
    { id: "color", label: "Color", multiple: false, accepts: "dimension", required: false },
  ],
  area: [
    { id: "x", label: "X axis", multiple: false, accepts: "dimension", required: true },
    { id: "y", label: "Y axis", multiple: true, accepts: "measure", required: true },
    { id: "color", label: "Color", multiple: false, accepts: "dimension", required: false },
  ],
  pie: [
    { id: "color", label: "Slices", multiple: false, accepts: "dimension", required: true },
    { id: "value", label: "Value", multiple: false, accepts: "measure", required: true },
  ],
  scatter: [
    { id: "x", label: "X axis", multiple: false, accepts: "measure", required: true },
    { id: "y", label: "Y axis", multiple: false, accepts: "measure", required: true },
    { id: "size", label: "Size", multiple: false, accepts: "measure", required: false },
    { id: "color", label: "Color", multiple: false, accepts: "dimension", required: false },
  ],
  kpi: [{ id: "value", label: "Value", multiple: false, accepts: "measure", required: true }],
  table: [{ id: "columns", label: "Columns", multiple: true, accepts: "any", required: true }],
};

/** A field placed in a drop zone. `id` doubles as the SQL output alias. */
export interface FieldRef {
  id: string;
  /** `column`: dataset column; `metric`: calculated metric id; `rows`: COUNT(*). */
  source: "column" | "metric" | "rows";
  field: string;
  agg: Aggregation;
  bucket?: DateBucket;
  label?: string;
}

export interface Encoding {
  x?: FieldRef;
  y: FieldRef[];
  color?: FieldRef;
  size?: FieldRef;
  value?: FieldRef;
  columns: FieldRef[];
}

export const emptyEncoding = (): Encoding => ({ y: [], columns: [] });

export type PaletteName = "default" | "ocean" | "sunset" | "forest" | "mono";

export const PALETTES: Record<PaletteName, string[]> = {
  default: ["#4f6bed", "#22b5a0", "#f5a524", "#e5484d", "#8e4ec6", "#12a5e6", "#f76b15", "#46a758"],
  ocean: ["#0b3c5d", "#1d7ea8", "#38a3d1", "#7cc6e8", "#b8e0f2", "#328cc1", "#0f5e8a", "#64b5d9"],
  sunset: ["#f94144", "#f3722c", "#f8961e", "#f9c74f", "#90be6d", "#43aa8b", "#577590", "#c44569"],
  forest: ["#2d6a4f", "#40916c", "#52b788", "#74c69d", "#95d5b2", "#1b4332", "#b7e4c7", "#081c15"],
  mono: ["#1f2937", "#374151", "#4b5563", "#6b7280", "#9ca3af", "#d1d5db", "#111827", "#e5e7eb"],
};

export type LegendPosition = "top" | "bottom" | "left" | "right";

export interface AxisConfig {
  title: string;
  showLabels: boolean;
}

export interface ChartConfig {
  title: string;
  showTitle: boolean;
  legend: { show: boolean; position: LegendPosition };
  xAxis: AxisConfig;
  yAxis: AxisConfig;
  palette: PaletteName;
  stacked: boolean;
  horizontal: boolean;
  donut: boolean;
  smooth: boolean;
  showDataLabels: boolean;
  kpi: { prefix: string; suffix: string; decimals: number };
}

export const defaultChartConfig = (title = ""): ChartConfig => ({
  title,
  showTitle: true,
  legend: { show: true, position: "top" },
  xAxis: { title: "", showLabels: true },
  yAxis: { title: "", showLabels: true },
  palette: "default",
  stacked: false,
  horizontal: false,
  donut: false,
  smooth: false,
  showDataLabels: false,
  kpi: { prefix: "", suffix: "", decimals: 0 },
});
