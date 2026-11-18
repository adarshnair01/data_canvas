import { useState } from "react";
import { useStore } from "zustand";
import { FunctionSquare, LayoutDashboard, Plus, Redo2, Undo2, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChartBuilder, CHART_ICONS } from "@/features/charts/ChartBuilder";
import { DashboardGrid } from "@/features/dashboard/DashboardGrid";
import { GlobalFiltersBar } from "@/features/dashboard/GlobalFiltersBar";
import { activeDashboard, findWidget, redo, undo, useDashboard } from "@/features/dashboard/store";
import { useData } from "@/features/data/store";
import { ExportMenu } from "@/features/export/ExportMenu";
import { shortcutLabel } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { CHART_TYPES, type ChartType } from "@/types/chart";
import { useUi } from "./uiStore";

function DashboardTabs() {
  const doc = useDashboard((s) => s.doc);
  const { setActiveDashboard, addDashboard, renameDashboard, removeDashboard } = useDashboard.getState();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {doc.dashboards.map((d) => (
        <div
          key={d.id}
          className={cn(
            "group flex shrink-0 items-center rounded-md text-sm",
            d.id === doc.activeDashboardId ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          {editing === d.id ? (
            <Input
              autoFocus
              className="h-7 w-36 text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft.trim()) renameDashboard(d.id, draft.trim());
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <button
              className="px-2.5 py-1"
              onClick={() => setActiveDashboard(d.id)}
              onDoubleClick={() => {
                setDraft(d.name);
                setEditing(d.id);
              }}
              title="Double-click to rename"
            >
              {d.name}
            </button>
          )}
          {doc.dashboards.length > 1 && editing !== d.id && (
            <button
              className="mr-1 rounded p-0.5 opacity-0 group-hover:opacity-60 hover:opacity-100"
              onClick={() => removeDashboard(d.id)}
              aria-label={`Delete ${d.name}`}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}
      <Button size="icon-xs" variant="ghost" onClick={() => addDashboard()} aria-label="Add dashboard">
        <Plus />
      </Button>
    </div>
  );
}

export function DashboardScreen() {
  const doc = useDashboard((s) => s.doc);
  const dashboard = activeDashboard(doc);
  const datasets = useData((s) => s.datasets);
  const selectedDatasetId = useData((s) => s.selectedId);
  const selectedWidgetId = useUi((s) => s.selectedWidgetId);
  const selectWidget = useUi((s) => s.selectWidget);
  const setMetricsOpen = useUi((s) => s.setMetricsOpen);
  const openImport = useUi((s) => s.openImport);
  const canUndo = useStore(useDashboard.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useDashboard.temporal, (s) => s.futureStates.length > 0);
  const selected = findWidget(doc, selectedWidgetId);
  const editing = selected && dashboard.widgets.some((w) => w.id === selected.id) ? selected : undefined;

  const addChart = (type: ChartType) => {
    const id = useDashboard.getState().addWidget(type, selectedDatasetId ?? datasets[0]?.id ?? null);
    selectWidget(id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <DashboardTabs />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" disabled={!canUndo} onClick={undo} aria-label="Undo">
                <Undo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo ({shortcutLabel("mod+z")})</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" disabled={!canRedo} onClick={redo} aria-label="Redo">
                <Redo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo ({shortcutLabel("mod+shift+z")})</TooltipContent>
          </Tooltip>
          <Button size="sm" variant="outline" onClick={() => setMetricsOpen(true)}>
            <FunctionSquare /> Metrics
          </Button>
          <ExportMenu />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus /> Add chart
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {CHART_TYPES.map(({ type, label }) => {
                const Icon = CHART_ICONS[type];
                return (
                  <DropdownMenuItem key={type} onClick={() => addChart(type)}>
                    <Icon /> {label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <GlobalFiltersBar filters={dashboard.globalFilters} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto bg-muted/30">
          {dashboard.widgets.length === 0 ? (
            <EmptyState
              className="h-full"
              icon={LayoutDashboard}
              title="This dashboard is empty"
              action={
                datasets.length ? (
                  <Button onClick={() => addChart("bar")}>
                    <Plus /> Add a chart
                  </Button>
                ) : (
                  <Button onClick={() => openImport()}>Import data…</Button>
                )
              }
            >
              {datasets.length
                ? "Add a chart, then drag fields from the editor into the drop zones."
                : "Import a dataset first, then add charts to visualise it."}
            </EmptyState>
          ) : (
            <DashboardGrid dashboard={dashboard} />
          )}
        </div>
        {editing && <ChartBuilder widget={editing} />}
      </div>
    </div>
  );
}
