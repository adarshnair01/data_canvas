import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { AreaChart, BarChart3, Gauge, LineChart, PieChart, ScatterChart, Table2, X } from "lucide-react";
import { useUi } from "@/app/uiStore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDashboard } from "@/features/dashboard/store";
import { useData } from "@/features/data/store";
import { cn } from "@/lib/utils";
import { CHART_TYPES, ZONES_BY_CHART, type ChartType, type DropZoneId, type FieldRef } from "@/types/chart";
import type { Widget } from "@/types/project";
import { ChartConfigPanel } from "./ChartConfigPanel";
import { DropZones } from "./DropZones";
import { autoZone, defaultRefFor, zoneAccepts, type DragItem } from "./fieldDefaults";
import { FieldList } from "./FieldList";
import { WidgetFilters } from "./WidgetFilters";

export const CHART_ICONS: Record<ChartType, typeof BarChart3> = {
  bar: BarChart3,
  line: LineChart,
  area: AreaChart,
  pie: PieChart,
  scatter: ScatterChart,
  kpi: Gauge,
  table: Table2,
};

function filledZones(w: Widget): Set<DropZoneId> {
  const e = w.encoding;
  const s = new Set<DropZoneId>();
  (["x", "color", "size", "value"] as const).forEach((z) => e[z] && s.add(z));
  if (e.y.length) s.add("y");
  if (e.columns.length) s.add("columns");
  return s;
}

function dragLabel(item: DragItem, metricsName: (id: string) => string) {
  return item.kind === "column" ? item.name : item.kind === "metric" ? metricsName(item.id) : "Row count";
}

export function ChartBuilder({ widget }: { widget: Widget }) {
  const datasets = useData((s) => s.datasets);
  const metrics = useDashboard((s) => s.doc.metrics);
  const setMetricsOpen = useUi((s) => s.setMetricsOpen);
  const selectWidget = useUi((s) => s.selectWidget);
  const dataset = datasets.find((d) => d.id === widget.datasetId);
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const store = useDashboard.getState();

  const place = (zone: DropZoneId, item: DragItem) => {
    if (!dataset) return;
    const ref = defaultRefFor(zone, item, widget.chartType, dataset, metrics);
    if (ref) store.putField(widget.id, zone, ref as Omit<FieldRef, "id">);
  };

  const onDragStart = (e: DragStartEvent) => setDragging(e.active.data.current as DragItem);
  const onDragEnd = (e: DragEndEvent) => {
    const item = e.active.data.current as DragItem | undefined;
    const zone = e.over?.data.current?.zone as DropZoneId | undefined;
    setDragging(null);
    if (item && zone) place(zone, item);
  };

  const accepts = dragging && dataset
    ? (z: (typeof ZONES_BY_CHART)[ChartType][number]) =>
        zoneAccepts(z, dragging) && defaultRefFor(z.id, dragging, widget.chartType, dataset, metrics) !== null
    : null;

  return (
    <div className="flex w-[34rem] shrink-0 flex-col border-l bg-card">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-sm font-semibold">Edit chart</span>
        <button className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => selectWidget(null)} aria-label="Close editor">
          <X className="size-4" />
        </button>
      </div>

      <div className="grid shrink-0 gap-2 border-b p-3">
        <Select value={widget.datasetId ?? ""} onValueChange={(v) => store.setDataset(widget.id, v)}>
          <SelectTrigger size="sm" className="h-8 w-full text-xs">
            <SelectValue placeholder="Choose a dataset" />
          </SelectTrigger>
          <SelectContent>
            {datasets.map((d) => (
              <SelectItem key={d.id} value={d.id} className="text-xs">
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="grid grid-cols-7 gap-1">
          {CHART_TYPES.map(({ type, label }) => {
            const Icon = CHART_ICONS[type];
            return (
              <button
                key={type}
                title={label}
                onClick={() => store.setChartType(widget.id, type)}
                className={cn(
                  "flex flex-col items-center gap-0.5 rounded-md border py-1.5 text-[10px]",
                  widget.chartType === type ? "border-primary bg-primary/5 text-primary" : "text-muted-foreground hover:bg-accent",
                )}
              >
                <Icon className="size-4" />
                {label.split(" ")[0]}
              </button>
            );
          })}
        </div>
      </div>

      {!dataset ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          {datasets.length ? "Choose a dataset to start building." : "Import a dataset first."}
        </div>
      ) : (
        <Tabs defaultValue="data" className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="mx-3 mt-2 w-auto">
            <TabsTrigger value="data" className="text-xs">Data</TabsTrigger>
            <TabsTrigger value="style" className="text-xs">Style</TabsTrigger>
            <TabsTrigger value="filters" className="text-xs">
              Filters{widget.filters.length ? ` (${widget.filters.length})` : ""}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="data" className="min-h-0 flex-1">
            <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
              <div className="grid h-full min-h-0 grid-cols-[13rem_1fr]">
                <div className="min-h-0 overflow-auto border-r px-1.5 pb-3">
                  <FieldList
                    dataset={dataset}
                    metrics={metrics}
                    onAdd={(item) => {
                      const z = autoZone(widget.chartType, item, dataset, filledZones(widget));
                      if (z) place(z, item);
                    }}
                  />
                  <button className="mt-3 w-full rounded border border-dashed px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setMetricsOpen(true)}>
                    + Calculated metric
                  </button>
                </div>
                <div className="min-h-0 overflow-auto p-3">
                  <DropZones widget={widget} dataset={dataset} accepts={accepts} />
                </div>
              </div>
              <DragOverlay dropAnimation={null}>
                {dragging && (
                  <div className="rounded-md border bg-background px-2 py-1 text-xs shadow-lg">
                    {dragLabel(dragging, (id) => metrics.find((m) => m.id === id)?.name ?? "Metric")}
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          </TabsContent>
          <TabsContent value="style" className="min-h-0 flex-1 overflow-auto p-3">
            <ChartConfigPanel widget={widget} />
          </TabsContent>
          <TabsContent value="filters" className="min-h-0 flex-1 overflow-auto p-3">
            <WidgetFilters widget={widget} dataset={dataset} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
