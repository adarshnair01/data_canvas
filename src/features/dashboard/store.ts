/**
 * Project document store: dashboards, widgets, layout, global filters and calculated metrics.
 * Undo/redo via zundo; only `doc` is tracked so UI-only flags don't create history entries.
 */

import { create } from "zustand";
import { temporal } from "zundo";
import { newId } from "@/lib/utils";
import {
  defaultChartConfig,
  emptyEncoding,
  type ChartConfig,
  type ChartType,
  type DropZoneId,
  type FieldRef,
  ZONES_BY_CHART,
} from "@/types/chart";
import type { CalculatedMetric } from "@/types/metrics";
import type { Dashboard, GlobalFilter, LayoutItem, NewGlobalFilter, ProjectDoc, Widget } from "@/types/project";
import type { Filter, SortSpec } from "@/types/query";

export const GRID_COLS = 12;
const DEFAULT_SIZE: Record<ChartType, { w: number; h: number }> = {
  bar: { w: 6, h: 8 },
  line: { w: 6, h: 8 },
  area: { w: 6, h: 8 },
  pie: { w: 4, h: 8 },
  scatter: { w: 6, h: 8 },
  kpi: { w: 3, h: 4 },
  table: { w: 12, h: 9 },
};

export function newDashboard(name = "Dashboard 1"): Dashboard {
  return { id: newId("db"), name, widgets: [], layout: [], globalFilters: [] };
}

export function newProjectDoc(name = "Untitled project"): ProjectDoc {
  const d = newDashboard();
  return { id: newId("pr"), name, dashboards: [d], activeDashboardId: d.id, metrics: [] };
}

/** First free slot scanning rows top-to-bottom, left-to-right. */
export function placeItem(layout: LayoutItem[], w: number, h: number): { x: number; y: number } {
  const occupied = (x: number, y: number) =>
    layout.some((l) => x < l.x + l.w && x + w > l.x && y < l.y + l.h && y + h > l.y);
  const maxY = layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + w <= GRID_COLS; x++) {
      if (!occupied(x, y)) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

export interface DocState {
  doc: ProjectDoc;
  dirty: boolean;

  newProject: (name?: string) => void;
  loadDoc: (doc: ProjectDoc) => void;
  markSaved: () => void;
  /** Unsaved changes outside `doc` (datasets, storage mode). */
  markDirty: () => void;
  renameProject: (name: string) => void;

  addDashboard: (name?: string) => string;
  renameDashboard: (id: string, name: string) => void;
  removeDashboard: (id: string) => void;
  setActiveDashboard: (id: string) => void;

  addWidget: (chartType: ChartType, datasetId: string | null) => string;
  updateWidget: (id: string, patch: Partial<Omit<Widget, "id">>) => void;
  updateConfig: (id: string, patch: Partial<ChartConfig>) => void;
  setChartType: (id: string, chartType: ChartType) => void;
  setDataset: (id: string, datasetId: string | null) => void;
  putField: (id: string, zone: DropZoneId, ref: Omit<FieldRef, "id"> & { id?: string }) => void;
  updateField: (id: string, refId: string, patch: Partial<Omit<FieldRef, "id">>) => void;
  removeField: (id: string, refId: string) => void;
  setWidgetFilters: (id: string, filters: Filter[]) => void;
  setWidgetSort: (id: string, sort: SortSpec[]) => void;
  duplicateWidget: (id: string) => string | null;
  removeWidget: (id: string) => void;
  setLayout: (layout: LayoutItem[]) => void;

  addGlobalFilter: (f: NewGlobalFilter) => string;
  updateGlobalFilter: (id: string, patch: Partial<GlobalFilter>) => void;
  removeGlobalFilter: (id: string) => void;

  addMetric: (m: Omit<CalculatedMetric, "id">) => string;
  updateMetric: (id: string, patch: Partial<Omit<CalculatedMetric, "id">>) => void;
  removeMetric: (id: string) => void;
}

export const activeDashboard = (doc: ProjectDoc): Dashboard =>
  doc.dashboards.find((d) => d.id === doc.activeDashboardId) ?? doc.dashboards[0];

function mapActive(doc: ProjectDoc, f: (d: Dashboard) => Dashboard): ProjectDoc {
  const active = activeDashboard(doc);
  return { ...doc, dashboards: doc.dashboards.map((d) => (d.id === active.id ? f(d) : d)) };
}

function mapWidget(doc: ProjectDoc, id: string, f: (w: Widget) => Widget): ProjectDoc {
  return {
    ...doc,
    dashboards: doc.dashboards.map((d) =>
      d.widgets.some((w) => w.id === id)
        ? { ...d, widgets: d.widgets.map((w) => (w.id === id ? f(w) : w)) }
        : d,
    ),
  };
}

function refIds(w: Widget): string[] {
  const e = w.encoding;
  return [e.x, e.color, e.size, e.value, ...e.y, ...e.columns]
    .filter((r): r is FieldRef => !!r)
    .map((r) => r.id);
}

/** Drop zones that don't exist for the new chart type, keeping compatible ones. */
function retainZones(w: Widget, chartType: ChartType): Widget["encoding"] {
  const zones = new Set(ZONES_BY_CHART[chartType].map((z) => z.id));
  const e = w.encoding;
  const enc = emptyEncoding();
  if (zones.has("x")) enc.x = e.x;
  if (zones.has("color")) enc.color = e.color;
  if (zones.has("size")) enc.size = e.size;
  if (zones.has("value")) enc.value = e.value ?? e.y[0];
  if (zones.has("y")) enc.y = chartType === "scatter" ? e.y.slice(0, 1) : e.y;
  if (zones.has("y") && !enc.y.length && e.value) enc.y = [e.value];
  if (zones.has("columns")) {
    enc.columns = e.columns.length
      ? e.columns
      : [e.x, e.color, ...e.y, e.value].filter((r): r is FieldRef => !!r);
  }
  return enc;
}

export const useDashboard = create<DocState>()(
  temporal(
    (set, get) => {
      const commit = (f: (doc: ProjectDoc) => ProjectDoc) =>
        set((s) => ({ doc: f(s.doc), dirty: true }));

      return {
        doc: newProjectDoc(),
        dirty: false,

        newProject: (name) => set({ doc: newProjectDoc(name), dirty: false }),
        loadDoc: (doc) => set({ doc, dirty: false }),
        markSaved: () => set({ dirty: false }),
        markDirty: () => set({ dirty: true }),
        renameProject: (name) => commit((doc) => ({ ...doc, name })),

        addDashboard: (name) => {
          const d = newDashboard(name ?? `Dashboard ${get().doc.dashboards.length + 1}`);
          commit((doc) => ({ ...doc, dashboards: [...doc.dashboards, d], activeDashboardId: d.id }));
          return d.id;
        },
        renameDashboard: (id, name) =>
          commit((doc) => ({
            ...doc,
            dashboards: doc.dashboards.map((d) => (d.id === id ? { ...d, name } : d)),
          })),
        removeDashboard: (id) =>
          commit((doc) => {
            if (doc.dashboards.length <= 1) return doc;
            const dashboards = doc.dashboards.filter((d) => d.id !== id);
            const activeDashboardId =
              doc.activeDashboardId === id ? dashboards[0].id : doc.activeDashboardId;
            return { ...doc, dashboards, activeDashboardId };
          }),
        setActiveDashboard: (id) =>
          set((s) => ({ doc: { ...s.doc, activeDashboardId: id } })),

        addWidget: (chartType, datasetId) => {
          const id = newId("w");
          commit((doc) =>
            mapActive(doc, (d) => {
              const size = DEFAULT_SIZE[chartType];
              const pos = placeItem(d.layout, size.w, size.h);
              const widget: Widget = {
                id,
                datasetId,
                chartType,
                encoding: emptyEncoding(),
                config: defaultChartConfig(),
                filters: [],
                sort: [],
              };
              return {
                ...d,
                widgets: [...d.widgets, widget],
                layout: [...d.layout, { i: id, ...pos, ...size }],
              };
            }),
          );
          return id;
        },
        updateWidget: (id, patch) => commit((doc) => mapWidget(doc, id, (w) => ({ ...w, ...patch }))),
        updateConfig: (id, patch) =>
          commit((doc) => mapWidget(doc, id, (w) => ({ ...w, config: { ...w.config, ...patch } }))),
        setChartType: (id, chartType) =>
          commit((doc) =>
            mapWidget(doc, id, (w) => {
              const encoding = retainZones(w, chartType);
              const next = { ...w, chartType, encoding };
              const ids = new Set(refIds(next));
              return { ...next, sort: w.sort.filter((s) => ids.has(s.by)) };
            }),
          ),
        setDataset: (id, datasetId) =>
          commit((doc) =>
            mapWidget(doc, id, (w) =>
              w.datasetId === datasetId
                ? w
                : { ...w, datasetId, encoding: emptyEncoding(), filters: [], sort: [] },
            ),
          ),
        putField: (id, zone, ref) =>
          commit((doc) =>
            mapWidget(doc, id, (w) => {
              const full: FieldRef = { ...ref, id: ref.id ?? newId("f") };
              const zoneDef = ZONES_BY_CHART[w.chartType].find((z) => z.id === zone);
              if (!zoneDef) return w;
              const e = { ...w.encoding, y: [...w.encoding.y], columns: [...w.encoding.columns] };
              if (zone === "y" || zone === "columns") {
                if (zoneDef.multiple) e[zone] = [...e[zone].filter((r) => r.id !== full.id), full];
                else e[zone] = [full];
              } else {
                e[zone] = full;
              }
              return { ...w, encoding: e };
            }),
          ),
        updateField: (id, refId, patch) =>
          commit((doc) =>
            mapWidget(doc, id, (w) => {
              const upd = (r?: FieldRef) => (r && r.id === refId ? { ...r, ...patch } : r);
              const e = w.encoding;
              return {
                ...w,
                encoding: {
                  x: upd(e.x),
                  color: upd(e.color),
                  size: upd(e.size),
                  value: upd(e.value),
                  y: e.y.map((r) => upd(r)!),
                  columns: e.columns.map((r) => upd(r)!),
                },
              };
            }),
          ),
        removeField: (id, refId) =>
          commit((doc) =>
            mapWidget(doc, id, (w) => {
              const keep = (r?: FieldRef) => (r && r.id === refId ? undefined : r);
              const e = w.encoding;
              return {
                ...w,
                encoding: {
                  x: keep(e.x),
                  color: keep(e.color),
                  size: keep(e.size),
                  value: keep(e.value),
                  y: e.y.filter((r) => r.id !== refId),
                  columns: e.columns.filter((r) => r.id !== refId),
                },
                sort: w.sort.filter((s) => s.by !== refId),
              };
            }),
          ),
        setWidgetFilters: (id, filters) => commit((doc) => mapWidget(doc, id, (w) => ({ ...w, filters }))),
        setWidgetSort: (id, sort) => commit((doc) => mapWidget(doc, id, (w) => ({ ...w, sort }))),
        duplicateWidget: (id) => {
          const d = get().doc.dashboards.find((x) => x.widgets.some((w) => w.id === id));
          const src = d?.widgets.find((w) => w.id === id);
          const srcLayout = d?.layout.find((l) => l.i === id);
          if (!d || !src || !srcLayout) return null;
          const copyId = newId("w");
          commit((doc) => ({
            ...doc,
            dashboards: doc.dashboards.map((x) => {
              if (x.id !== d.id) return x;
              const pos = placeItem(x.layout, srcLayout.w, srcLayout.h);
              const copy: Widget = structuredClone({ ...src, id: copyId });
              if (copy.config.title) copy.config.title = `${copy.config.title} (copy)`;
              return {
                ...x,
                widgets: [...x.widgets, copy],
                layout: [...x.layout, { i: copyId, w: srcLayout.w, h: srcLayout.h, ...pos }],
              };
            }),
          }));
          return copyId;
        },
        removeWidget: (id) =>
          commit((doc) => ({
            ...doc,
            dashboards: doc.dashboards.map((d) => ({
              ...d,
              widgets: d.widgets.filter((w) => w.id !== id),
              layout: d.layout.filter((l) => l.i !== id),
            })),
          })),
        setLayout: (layout) =>
          commit((doc) =>
            mapActive(doc, (d) => {
              const clean = layout
                .filter((l) => d.widgets.some((w) => w.id === l.i))
                .map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
              const same =
                clean.length === d.layout.length &&
                clean.every((l) => {
                  const o = d.layout.find((p) => p.i === l.i);
                  return o && o.x === l.x && o.y === l.y && o.w === l.w && o.h === l.h;
                });
              return same ? d : { ...d, layout: clean };
            }),
          ),

        addGlobalFilter: (f) => {
          const id = newId("gf");
          commit((doc) =>
            mapActive(doc, (d) => ({
              ...d,
              globalFilters: [...d.globalFilters, { ...f, id } as GlobalFilter],
            })),
          );
          return id;
        },
        updateGlobalFilter: (id, patch) =>
          commit((doc) =>
            mapActive(doc, (d) => ({
              ...d,
              globalFilters: d.globalFilters.map((g) =>
                g.id === id ? ({ ...g, ...patch } as GlobalFilter) : g,
              ),
            })),
          ),
        removeGlobalFilter: (id) =>
          commit((doc) =>
            mapActive(doc, (d) => ({
              ...d,
              globalFilters: d.globalFilters.filter((g) => g.id !== id),
            })),
          ),

        addMetric: (m) => {
          const id = newId("m");
          commit((doc) => ({ ...doc, metrics: [...doc.metrics, { ...m, id }] }));
          return id;
        },
        updateMetric: (id, patch) =>
          commit((doc) => ({
            ...doc,
            metrics: doc.metrics.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          })),
        removeMetric: (id) =>
          commit((doc) => ({
            ...doc,
            metrics: doc.metrics.filter((m) => m.id !== id),
            dashboards: doc.dashboards.map((d) => ({
              ...d,
              widgets: d.widgets.map((w) => {
                const drop = (r?: FieldRef) => (r && r.source === "metric" && r.field === id ? undefined : r);
                const e = w.encoding;
                return {
                  ...w,
                  encoding: {
                    x: drop(e.x),
                    color: drop(e.color),
                    size: drop(e.size),
                    value: drop(e.value),
                    y: e.y.filter((r) => drop(r)),
                    columns: e.columns.filter((r) => drop(r)),
                  },
                };
              }),
            })),
          })),
      };
    },
    {
      partialize: (s) => ({ doc: s.doc }),
      equality: (a, b) => a.doc === b.doc,
      limit: 100,
    },
  ),
);

export const undo = () => useDashboard.temporal.getState().undo();
export const redo = () => useDashboard.temporal.getState().redo();
export const clearHistory = () => useDashboard.temporal.getState().clear();

export function findWidget(doc: ProjectDoc, id: string | null): Widget | undefined {
  if (!id) return undefined;
  for (const d of doc.dashboards) {
    const w = d.widgets.find((x) => x.id === id);
    if (w) return w;
  }
  return undefined;
}
