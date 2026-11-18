import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import { registerChart, type ChartImageSource } from "@/features/export/chartRegistry";
import { useReducedMotionPref } from "@/lib/motion";
import { useIsDark } from "@/lib/theme";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };

export interface EChartHandle extends ChartImageSource {
  getInstance: () => echarts.ECharts | null;
}

interface EChartProps {
  option: EChartsOption;
  /** Widget id under which the chart is registered for PNG/PDF export. */
  exportId?: string;
}

/**
 * Everything but the data: when two consecutive options share this key the chart is updated in
 * place, so ECharts animates bars/lines/slices to their new values instead of redrawing.
 */
export function optionShape(option: EChartsOption): string {
  return JSON.stringify(option, (k, v) => (k === "data" ? undefined : v));
}

/** Canvas renderer so widgets can be exported with `getDataURL`. */
export const EChart = forwardRef<EChartHandle, EChartProps>(function EChart({ option, exportId }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const shape = useRef<string | null>(null);
  const dark = useIsDark();
  const reduced = useReducedMotionPref();

  const source = useRef<EChartHandle>({
    getInstance: () => chart.current,
    getDataURL: (opts) =>
      chart.current?.getDataURL({
        type: "png",
        pixelRatio: opts?.pixelRatio ?? 2,
        backgroundColor: opts?.backgroundColor ?? "#ffffff",
      }) ?? null,
    getSize: () => (chart.current ? { width: chart.current.getWidth(), height: chart.current.getHeight() } : null),
  }).current;

  useImperativeHandle(ref, () => source, [source]);

  useEffect(() => (exportId ? registerChart(exportId, source) : undefined), [exportId, source]);

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, dark ? "dark" : undefined, { renderer: "canvas" });
    chart.current = instance;
    shape.current = null;
    const observer = new ResizeObserver(() => instance.resize({ animation: { duration: 0 } }));
    observer.observe(el.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [dark]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const next = reduced ? ({ ...option, animation: false } as EChartsOption) : option;
    const key = optionShape(next);
    instance.setOption(next, { notMerge: key !== shape.current, lazyUpdate: true });
    shape.current = key;
  }, [option, reduced, dark]);

  return <div ref={el} className="size-full" />;
});
