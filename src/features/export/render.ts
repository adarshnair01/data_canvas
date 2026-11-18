/** Widget -> PNG data URL. Charts go through ECharts `getDataURL`; KPI and table are drawn on a canvas. */

import type { EChartsOption } from "echarts";
import { echarts } from "@/features/charts/EChart";
import { chartOption, kpiModel, tableModel } from "@/features/charts/options";
import { buildQuerySpec } from "@/features/charts/specBuilder";
import { ipc } from "@/lib/ipc";
import type { DatasetMeta } from "@/types/dataset";
import type { CalculatedMetric } from "@/types/metrics";
import type { GlobalFilter, Widget } from "@/types/project";
import { mountedChart } from "./chartRegistry";
import { browserCanvas, type CanvasDeps } from "./composite";
import { drawKpi, drawTable } from "./drawWidgets";

export interface WidgetContext {
  dataset: DatasetMeta | undefined;
  metrics: CalculatedMetric[];
  globalFilters: GlobalFilter[];
}

export type WidgetImage = { ok: true; dataUrl: string } | { ok: false; reason: string };

export const EXPORT_SCALE = 2;

const ECHARTS_TYPES = new Set<Widget["chartType"]>(["bar", "line", "area", "pie", "scatter"]);

export const usesECharts = (w: Widget) => ECHARTS_TYPES.has(w.chartType);

/** Render an option into a detached chart at an exact size and return its PNG. */
export function renderOptionOffscreen(option: EChartsOption, width: number, height: number, scale = EXPORT_SCALE): string {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;`;
  document.body.appendChild(host);
  const chart = echarts.init(host, undefined, { renderer: "canvas", width, height });
  try {
    chart.setOption({ ...option, animation: false } as EChartsOption, { notMerge: true });
    return chart.getDataURL({ type: "png", pixelRatio: scale, backgroundColor: "#ffffff" });
  } finally {
    chart.dispose();
    host.remove();
  }
}

/** Run the widget's QuerySpec and render it at `width` x `height` logical pixels. */
export async function renderWidget(
  widget: Widget,
  ctx: WidgetContext,
  width: number,
  height: number,
  deps: CanvasDeps = browserCanvas,
  scale = EXPORT_SCALE,
): Promise<WidgetImage> {
  const built = buildQuerySpec(widget, ctx.dataset, ctx.metrics, ctx.globalFilters);
  if (!built.ok) return { ok: false, reason: built.reason };
  const result = await ipc.runQuery(built.spec);

  const option = chartOption(widget, result, ctx.metrics);
  if (option) return { ok: true, dataUrl: renderOptionOffscreen(option, width, height, scale) };

  const canvas = deps.createCanvas(Math.round(width * scale), Math.round(height * scale));
  const c = canvas.getContext("2d");
  if (!c) throw new Error("Canvas 2D is not available");
  c.scale(scale, scale);
  const title = widget.config.showTitle ? widget.config.title || undefined : undefined;
  if (widget.chartType === "kpi") drawKpi(c, kpiModel(widget, result, ctx.metrics), title, width, height);
  else drawTable(c, tableModel(widget, result, ctx.metrics), title, width, height);
  return { ok: true, dataUrl: canvas.toDataURL("image/png") };
}

/**
 * Per-widget PNG at the on-screen chart's size. Always rendered offscreen, so the file never
 * captures a mid-animation frame or the dark theme.
 */
export async function widgetPng(widget: Widget, ctx: WidgetContext, fallback = { width: 800, height: 500 }): Promise<WidgetImage> {
  const mounted = usesECharts(widget) ? mountedChart(widget.id) : undefined;
  const size = mounted?.getSize() ?? fallback;
  return renderWidget(widget, ctx, size.width, size.height);
}
