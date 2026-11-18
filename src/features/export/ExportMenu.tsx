import { useState } from "react";
import { Download, FileImage, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { useUi } from "@/app/uiStore";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { activeDashboard, findWidget, useDashboard } from "@/features/dashboard/store";
import { useData } from "@/features/data/store";
import {
  exportDashboardPng,
  exportDatasetCsv,
  exportProjectPdf,
  exportWidgetCsv,
  exportWidgetPng,
  widgetDisplayName,
} from "./actions";

/** Dashboard toolbar menu for PNG, PDF and CSV exports. */
export function ExportMenu() {
  const [busy, setBusy] = useState(false);
  const doc = useDashboard((s) => s.doc);
  const datasets = useData((s) => s.datasets);
  const selectedId = useUi((s) => s.selectedWidgetId);
  const dashboard = activeDashboard(doc);
  const selected = findWidget(doc, selectedId);
  const widget = selected && dashboard.widgets.some((w) => w.id === selected.id) ? selected : undefined;
  const anyWidgets = doc.dashboards.some((d) => d.widgets.length > 0);

  const go = (f: () => Promise<void>) => {
    setBusy(true);
    void f().finally(() => setBusy(false));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />} Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Dashboard</DropdownMenuLabel>
        <DropdownMenuItem disabled={!dashboard.widgets.length} onClick={() => go(() => exportDashboardPng(dashboard.id))}>
          <FileImage /> “{dashboard.name}” as PNG…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!anyWidgets} onClick={() => go(exportProjectPdf)}>
          <FileText /> All dashboards as PDF…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="truncate">
          {widget ? `Widget: ${widgetDisplayName(widget)}` : "Widget (select one first)"}
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={!widget} onClick={() => widget && go(() => exportWidgetPng(widget.id))}>
          <FileImage /> Widget as PNG…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!widget?.datasetId} onClick={() => widget && go(() => exportWidgetCsv(widget.id))}>
          <FileSpreadsheet /> Widget data as CSV…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!datasets.length}>
            <FileSpreadsheet /> Full dataset as CSV
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {datasets.map((d) => (
              <DropdownMenuItem key={d.id} onClick={() => go(() => exportDatasetCsv(d.id))}>
                <span className="truncate">{d.name}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{d.rowCount.toLocaleString()}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
