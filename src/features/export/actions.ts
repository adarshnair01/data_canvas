/** User-facing export actions: each asks for a destination, renders/exports, and reports via toast. */

import { toast, useUi } from "@/app/uiStore";
import { buildQuerySpec, refLabel } from "@/features/charts/specBuilder";
import { activeDashboard, findWidget, useDashboard } from "@/features/dashboard/store";
import { useData } from "@/features/data/store";
import { ipc, type ColumnLabel } from "@/lib/ipc";
import { CHART_TYPES, type FieldRef } from "@/types/chart";
import { isAppError } from "@/types/errors";
import type { Dashboard, Widget } from "@/types/project";
import { composeDashboard, type RasterImage, type Tile } from "./composite";
import { dataUrlToBytes, pickExportPath, shownPath, writeExportBytes } from "./files";
import { cardContent, gridRect } from "./layout";
import { buildPdf } from "./pdf";
import { renderWidget, widgetPng, type WidgetContext } from "./render";

function contextFor(widget: Widget, dashboard: Dashboard): WidgetContext {
  return {
    dataset: useData.getState().datasets.find((d) => d.id === widget.datasetId),
    metrics: useDashboard.getState().doc.metrics,
    globalFilters: dashboard.globalFilters,
  };
}

function dashboardOf(widgetId: string): Dashboard | undefined {
  return useDashboard.getState().doc.dashboards.find((d) => d.widgets.some((w) => w.id === widgetId));
}

export function widgetDisplayName(w: Widget): string {
  return w.config.title || CHART_TYPES.find((c) => c.type === w.chartType)?.label || "Widget";
}

function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

async function run(title: string, f: () => Promise<string | null>) {
  try {
    const done = await f();
    if (done) toast({ tone: "success", title, description: done });
  } catch (e) {
    toast({ tone: "error", title: `${title} failed`, description: errorMessage(e) });
  } finally {
    useUi.getState().setExporting(null);
  }
}

/** Show the progress pill once the destination is chosen and the work starts. */
const working = (label: string) => useUi.getState().setExporting(label);

const today = () => new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Render every widget of a dashboard at its grid size and composite them into one image. */
export async function renderDashboard(dashboard: Dashboard, subtitle?: string): Promise<RasterImage> {
  const tiles: Tile[] = await Promise.all(
    dashboard.layout.map(async (item): Promise<Tile> => {
      const widget = dashboard.widgets.find((w) => w.id === item.i);
      if (!widget) return { id: item.i, dataUrl: null };
      const box = cardContent(gridRect(item));
      try {
        const img = await renderWidget(widget, contextFor(widget, dashboard), box.w, box.h);
        return img.ok ? { id: item.i, dataUrl: img.dataUrl } : { id: item.i, dataUrl: null, placeholder: img.reason };
      } catch (e) {
        return { id: item.i, dataUrl: null, placeholder: errorMessage(e) };
      }
    }),
  );
  return composeDashboard({ title: dashboard.name, subtitle, layout: dashboard.layout, tiles });
}

export function exportWidgetPng(widgetId: string) {
  return run("Exported PNG", async () => {
    const doc = useDashboard.getState().doc;
    const widget = findWidget(doc, widgetId);
    const dashboard = dashboardOf(widgetId);
    if (!widget || !dashboard) throw new Error("Widget not found");
    const path = await pickExportPath("png", `${doc.name} - ${widgetDisplayName(widget)}`, "Export widget as PNG");
    if (!path) return null;
    working("Rendering widget…");
    const img = await widgetPng(widget, contextFor(widget, dashboard));
    if (!img.ok) throw new Error(img.reason);
    await writeExportBytes(path, dataUrlToBytes(img.dataUrl), "png");
    return shownPath(path);
  });
}

export function exportDashboardPng(dashboardId?: string) {
  return run("Exported dashboard PNG", async () => {
    const doc = useDashboard.getState().doc;
    const dashboard = doc.dashboards.find((d) => d.id === dashboardId) ?? activeDashboard(doc);
    if (!dashboard.widgets.length) throw new Error("This dashboard has no widgets");
    const path = await pickExportPath("png", `${doc.name} - ${dashboard.name}`, "Export dashboard as PNG");
    if (!path) return null;
    working("Rendering dashboard…");
    const img = await renderDashboard(dashboard, `${doc.name} · ${today()}`);
    await writeExportBytes(path, dataUrlToBytes(img.dataUrl), "png");
    return shownPath(path);
  });
}

/** One page per dashboard; empty dashboards are skipped. */
export function exportProjectPdf() {
  return run("Exported PDF", async () => {
    const doc = useDashboard.getState().doc;
    const dashboards = doc.dashboards.filter((d) => d.widgets.length);
    if (!dashboards.length) throw new Error("There are no widgets to export");
    const path = await pickExportPath("pdf", doc.name, "Export dashboards as PDF");
    if (!path) return null;
    const pages = [];
    for (const [i, d] of dashboards.entries()) {
      working(`Rendering page ${i + 1} of ${dashboards.length}…`);
      pages.push({ title: d.name, image: await renderDashboard(d) });
    }
    working("Building PDF…");
    const bytes = await buildPdf(pages, { title: doc.name, subtitle: `${doc.name} · ${today()}` });
    await writeExportBytes(path, bytes, "pdf");
    return `${pages.length} page${pages.length === 1 ? "" : "s"} · ${shownPath(path)}`;
  });
}

/** CSV headers use the same labels as the chart (e.g. "Sum of revenue"). */
export function columnLabels(widget: Widget, metrics = useDashboard.getState().doc.metrics): ColumnLabel[] {
  const e = widget.encoding;
  return [e.x, e.color, e.size, e.value, ...e.y, ...e.columns]
    .filter((r): r is FieldRef => !!r)
    .map((r) => ({ id: r.id, label: refLabel(r, metrics) }));
}

export function exportWidgetCsv(widgetId: string) {
  return run("Exported CSV", async () => {
    const doc = useDashboard.getState().doc;
    const widget = findWidget(doc, widgetId);
    const dashboard = dashboardOf(widgetId);
    if (!widget || !dashboard) throw new Error("Widget not found");
    const ctx = contextFor(widget, dashboard);
    const built = buildQuerySpec(widget, ctx.dataset, ctx.metrics, ctx.globalFilters);
    if (!built.ok) throw new Error(built.reason);
    const path = await pickExportPath("csv", `${doc.name} - ${widgetDisplayName(widget)}`, "Export widget data as CSV");
    if (!path) return null;
    working("Exporting CSV…");
    const { rows } = await ipc.exportQueryCsv(built.spec, path, columnLabels(widget, ctx.metrics));
    return `${rows.toLocaleString()} rows · ${shownPath(path)}`;
  });
}

export function exportDatasetCsv(datasetId: string) {
  return run("Exported CSV", async () => {
    const dataset = useData.getState().datasets.find((d) => d.id === datasetId);
    if (!dataset) throw new Error("Dataset not found");
    const path = await pickExportPath("csv", dataset.name, "Export dataset as CSV");
    if (!path) return null;
    working("Exporting CSV…");
    const { rows } = await ipc.exportDatasetCsv(dataset.id, path);
    return `${rows.toLocaleString()} rows · ${shownPath(path)}`;
  });
}
