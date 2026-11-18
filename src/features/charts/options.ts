/** Query results -> ECharts options. Pure functions so they can be unit-tested. */

import type { EChartsOption } from "echarts";
import { PALETTES, type FieldRef } from "@/types/chart";
import type { CellValue } from "@/types/dataset";
import type { CalculatedMetric } from "@/types/metrics";
import type { Widget } from "@/types/project";
import type { DateBucket, QueryResult } from "@/types/query";
import { refLabel } from "./specBuilder";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatCategory(v: CellValue, bucket?: DateBucket): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string" && bucket && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const y = v.slice(0, 4);
    const m = Number(v.slice(5, 7));
    switch (bucket) {
      case "year":
        return y;
      case "quarter":
        return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
      case "month":
        return `${MONTHS[m - 1]} ${y}`;
      default:
        return v.slice(0, 10);
    }
  }
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

export function formatNumber(v: CellValue, decimals?: number): string {
  if (v === null || v === undefined) return "–";
  if (typeof v !== "number") return String(v);
  const d = decimals ?? (Number.isInteger(v) ? 0 : 2);
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function toNumber(v: CellValue): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function col(result: QueryResult, id: string | undefined): number {
  return id ? result.columns.findIndex((c) => c.id === id) : -1;
}

function legendLayout(w: Widget): EChartsOption["legend"] {
  const { show, position } = w.config.legend;
  const base = { show, type: "scroll" as const };
  switch (position) {
    case "bottom":
      return { ...base, bottom: 0 };
    case "left":
      return { ...base, left: 0, top: "middle", orient: "vertical" };
    case "right":
      return { ...base, right: 0, top: "middle", orient: "vertical" };
    default:
      return { ...base, top: w.config.showTitle && w.config.title ? 28 : 0 };
  }
}

function grid(w: Widget): EChartsOption["grid"] {
  const { show, position } = w.config.legend;
  const titled = w.config.showTitle && !!w.config.title;
  return {
    containLabel: true,
    left: show && position === "left" ? 110 : 12,
    right: show && position === "right" ? 110 : 16,
    top: (titled ? 32 : 8) + (show && position === "top" ? 28 : 0),
    bottom: show && position === "bottom" ? 32 : 8,
  };
}

function base(w: Widget): EChartsOption {
  return {
    color: PALETTES[w.config.palette] ?? PALETTES.default,
    backgroundColor: "transparent",
    // Entrance and data-change transitions; turned off for reduced motion and for exports.
    animation: true,
    animationDuration: 650,
    animationEasing: "cubicOut",
    animationDurationUpdate: 450,
    animationEasingUpdate: "cubicInOut",
    title: {
      show: w.config.showTitle && !!w.config.title,
      text: w.config.title,
      left: 0,
      textStyle: { fontSize: 13, fontWeight: 600 },
    },
    legend: legendLayout(w),
  };
}

/** Bar, line and area. With a color dimension the result is pivoted into one series per value. */
export function cartesianOption(
  w: Widget,
  result: QueryResult,
  metrics: CalculatedMetric[] = [],
): EChartsOption {
  const e = w.encoding;
  const xi = col(result, e.x?.id);
  const ci = col(result, e.color?.id);
  const categories: string[] = [];
  const catIndex = new Map<string, number>();
  for (const row of result.rows) {
    const c = formatCategory(row[xi], e.x?.bucket);
    if (!catIndex.has(c)) {
      catIndex.set(c, categories.length);
      categories.push(c);
    }
  }

  const seriesData: { name: string; data: (number | null)[] }[] = [];
  if (ci >= 0) {
    const mi = col(result, e.y[0]?.id);
    const byName = new Map<string, (number | null)[]>();
    for (const row of result.rows) {
      const name = formatCategory(row[ci], e.color?.bucket);
      if (!byName.has(name)) {
        const arr = new Array<number | null>(categories.length).fill(null);
        byName.set(name, arr);
        seriesData.push({ name, data: arr });
      }
      byName.get(name)![catIndex.get(formatCategory(row[xi], e.x?.bucket))!] = toNumber(row[mi]);
    }
  } else {
    for (const ref of e.y) {
      const mi = col(result, ref.id);
      const data = new Array<number | null>(categories.length).fill(null);
      for (const row of result.rows) data[catIndex.get(formatCategory(row[xi], e.x?.bucket))!] = toNumber(row[mi]);
      seriesData.push({ name: refLabel(ref, metrics), data });
    }
  }

  const type = w.chartType === "bar" ? "bar" : "line";
  const stacked = w.config.stacked;
  const series = seriesData.map((s) => ({
    type,
    name: s.name,
    data: s.data,
    stack: stacked ? "total" : undefined,
    areaStyle: w.chartType === "area" ? { opacity: 0.35 } : undefined,
    smooth: type === "line" ? w.config.smooth : undefined,
    showSymbol: type === "line" ? categories.length <= 60 : undefined,
    connectNulls: type === "line" ? true : undefined,
    label: { show: w.config.showDataLabels, position: type === "bar" ? ("top" as const) : undefined },
  }));

  const categoryAxis = {
    type: "category" as const,
    data: categories,
    name: w.config.xAxis.title || undefined,
    nameLocation: "middle" as const,
    nameGap: 28,
    axisLabel: { show: w.config.xAxis.showLabels, hideOverlap: true },
    boundaryGap: type === "bar",
  };
  const valueAxis = {
    type: "value" as const,
    name: w.config.yAxis.title || undefined,
    axisLabel: { show: w.config.yAxis.showLabels },
  };
  const horizontal = w.chartType === "bar" && w.config.horizontal;

  return {
    ...base(w),
    tooltip: { trigger: "axis", confine: true },
    grid: grid(w),
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series,
  } as EChartsOption;
}

export function pieOption(w: Widget, result: QueryResult): EChartsOption {
  const e = w.encoding;
  const ci = col(result, e.color?.id);
  const vi = col(result, e.value?.id);
  const data = result.rows.map((row) => ({
    name: formatCategory(row[ci], e.color?.bucket),
    value: toNumber(row[vi]) ?? 0,
  }));
  return {
    ...base(w),
    tooltip: { trigger: "item", confine: true },
    series: [
      {
        type: "pie",
        radius: w.config.donut ? ["45%", "70%"] : "70%",
        center: ["50%", "55%"],
        data,
        label: { show: w.config.showDataLabels, formatter: "{b}: {d}%" },
      },
    ],
  };
}

const MIN_SYMBOL = 6;
const MAX_SYMBOL = 36;

export function scatterOption(
  w: Widget,
  result: QueryResult,
  metrics: CalculatedMetric[] = [],
): EChartsOption {
  const e = w.encoding;
  const xi = col(result, e.x?.id);
  const yi = col(result, e.y[0]?.id);
  const si = col(result, e.size?.id);
  const ci = col(result, e.color?.id);
  const sizes = si >= 0 ? result.rows.map((r) => toNumber(r[si]) ?? 0) : [];
  const maxSize = Math.max(1e-9, ...sizes.map(Math.abs));
  const groups = new Map<string, { value: (number | null)[]; symbolSize: number }[]>();
  result.rows.forEach((row, idx) => {
    const name = ci >= 0 ? formatCategory(row[ci]) : refLabel(e.y[0], metrics);
    if (!groups.has(name)) groups.set(name, []);
    const symbolSize =
      si >= 0 ? MIN_SYMBOL + (Math.abs(sizes[idx]) / maxSize) * (MAX_SYMBOL - MIN_SYMBOL) : 10;
    const value = [toNumber(row[xi]), toNumber(row[yi])];
    if (si >= 0) value.push(sizes[idx]);
    groups.get(name)!.push({ value, symbolSize: Math.round(symbolSize * 10) / 10 });
  });
  return {
    ...base(w),
    tooltip: { trigger: "item", confine: true },
    grid: grid(w),
    xAxis: {
      type: "value",
      scale: true,
      name: w.config.xAxis.title || (e.x ? refLabel(e.x, metrics) : undefined),
      nameLocation: "middle",
      nameGap: 28,
      axisLabel: { show: w.config.xAxis.showLabels },
    },
    yAxis: {
      type: "value",
      scale: true,
      name: w.config.yAxis.title || (e.y[0] ? refLabel(e.y[0], metrics) : undefined),
      axisLabel: { show: w.config.yAxis.showLabels },
    },
    series: [...groups.entries()].map(([name, data]) => ({ type: "scatter", name, data })),
  };
}

/** ECharts option for chart types rendered by ECharts; `null` for KPI and table. */
export function chartOption(
  w: Widget,
  result: QueryResult,
  metrics: CalculatedMetric[] = [],
): EChartsOption | null {
  switch (w.chartType) {
    case "bar":
    case "line":
    case "area":
      return cartesianOption(w, result, metrics);
    case "pie":
      return pieOption(w, result);
    case "scatter":
      return scatterOption(w, result, metrics);
    default:
      return null;
  }
}

export interface KpiModel {
  value: number | null;
  text: string;
  label: string;
}

export function kpiModel(w: Widget, result: QueryResult, metrics: CalculatedMetric[] = []): KpiModel {
  const ref = w.encoding.value;
  const vi = col(result, ref?.id);
  const raw = vi >= 0 && result.rows[0] ? result.rows[0][vi] : null;
  const value = toNumber(raw);
  const { prefix, suffix, decimals } = w.config.kpi;
  const text = value === null ? (raw === null ? "–" : String(raw)) : `${prefix}${formatNumber(value, decimals)}${suffix}`;
  return { value, text, label: ref ? refLabel(ref, metrics) : "" };
}

export interface TableModel {
  headers: { id: string; label: string; numeric: boolean }[];
  rows: string[][];
}

export function tableModel(w: Widget, result: QueryResult, metrics: CalculatedMetric[] = []): TableModel {
  const refs = new Map<string, FieldRef>(w.encoding.columns.map((r) => [r.id, r]));
  const headers = result.columns.map((c) => ({
    id: c.id,
    label: refs.has(c.id) ? refLabel(refs.get(c.id)!, metrics) : c.id,
    numeric: c.role === "measure",
  }));
  const rows = result.rows.map((row) =>
    row.map((v, i) => {
      const ref = refs.get(result.columns[i].id);
      return typeof v === "number" ? formatNumber(v) : formatCategory(v, ref?.bucket);
    }),
  );
  return { headers, rows };
}
