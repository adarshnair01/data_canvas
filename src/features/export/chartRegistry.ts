/** Mounted ECharts instances keyed by widget id, so exports can reuse what is on screen. */

export interface ChartImageSource {
  getDataURL: (opts?: { pixelRatio?: number; backgroundColor?: string }) => string | null;
  getSize: () => { width: number; height: number } | null;
}

const charts = new Map<string, ChartImageSource>();

export function registerChart(widgetId: string, source: ChartImageSource): () => void {
  charts.set(widgetId, source);
  return () => {
    if (charts.get(widgetId) === source) charts.delete(widgetId);
  };
}

export function mountedChart(widgetId: string): ChartImageSource | undefined {
  return charts.get(widgetId);
}
