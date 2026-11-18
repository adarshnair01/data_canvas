import { useEffect, useState } from "react";
import { Database, FileSpreadsheet, FileText, LayoutDashboard, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboard } from "@/features/dashboard/store";
import { PreviewGrid } from "@/features/data/PreviewGrid";
import { SchemaPanel } from "@/features/data/SchemaPanel";
import { useData } from "@/features/data/store";
import { reloadSource } from "@/features/project/actions";
import { confirmDialog } from "@/lib/dialogs";
import { IS_WEB } from "@/lib/target";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/types/errors";
import { toast, useUi } from "./uiStore";

export function DataScreen() {
  const datasets = useData((s) => s.datasets);
  const selectedId = useData((s) => s.selectedId);
  const select = useData((s) => s.select);
  const openImport = useUi((s) => s.openImport);
  const dataset = datasets.find((d) => d.id === selectedId) ?? datasets[0];
  const [column, setColumn] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    setColumn(dataset?.columns[0]?.name ?? null);
    setRenaming(false);
  }, [dataset?.id]);

  const rename = async () => {
    setRenaming(false);
    if (!dataset || !draftName.trim() || draftName === dataset.name) return;
    try {
      await useData.getState().rename(dataset.id, draftName.trim());
    } catch (e) {
      toast({ tone: "error", title: "Rename failed", description: errorMessage(e) });
    }
  };

  const remove = async () => {
    if (!dataset) return;
    if (!(await confirmDialog(`Remove "${dataset.name}" from this session? Charts using it will show an error.`))) return;
    await useData.getState().remove(dataset.id);
  };

  const reload = async () => {
    if (!dataset) return;
    setReloading(true);
    try {
      await reloadSource(dataset.id);
    } finally {
      setReloading(false);
    }
  };

  const chartIt = () => {
    if (!dataset) return;
    const id = useDashboard.getState().addWidget("bar", dataset.id);
    useUi.getState().selectWidget(id);
    useUi.getState().navigate("dashboard");
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-60 shrink-0 flex-col border-r">
        <div className="flex h-12 items-center justify-between border-b px-3">
          <span className="text-sm font-semibold">Datasets</span>
          <Button size="icon-sm" variant="ghost" onClick={() => openImport()} aria-label="Import data">
            <Plus />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {datasets.map((d) => {
            const Icon = d.source.kind === "xlsx" ? FileSpreadsheet : FileText;
            return (
              <button
                key={d.id}
                onClick={() => select(d.id)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
                  d.id === dataset?.id ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", d.source.kind === "xlsx" ? "text-emerald-600" : "text-primary")} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{d.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {d.rowCount.toLocaleString()} rows · {d.columns.length} cols
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {!dataset ? (
        <EmptyState
          className="flex-1"
          icon={Database}
          title="No data yet"
          action={<Button onClick={() => openImport()}>Import data…</Button>}
        >
          Import a CSV or Excel file, or drop one onto the {IS_WEB ? "page" : "window"}, to preview and chart it.
        </EmptyState>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
            {renaming ? (
              <Input
                autoFocus
                className="h-8 w-72"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => void rename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void rename();
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
            ) : (
              <button
                className="group flex items-center gap-1.5 font-semibold"
                onClick={() => {
                  setDraftName(dataset.name);
                  setRenaming(true);
                }}
              >
                {dataset.name}
                <Pencil className="size-3 opacity-0 group-hover:opacity-60" />
              </button>
            )}
            <span className="truncate text-xs text-muted-foreground" title={dataset.source.path} data-selectable>
              {dataset.source.path}
              {dataset.source.sheet ? ` › ${dataset.source.sheet}` : ""}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={reloading} onClick={() => void reload()}>
                <RefreshCw className={cn(reloading && "animate-spin")} /> Reload source
              </Button>
              <Button size="sm" onClick={chartIt}>
                <LayoutDashboard /> Chart this
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => void remove()} aria-label="Remove dataset">
                <Trash2 />
              </Button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1">
            <PreviewGrid dataset={dataset} selectedColumn={column} onSelectColumn={setColumn} />
            <SchemaPanel dataset={dataset} selectedColumn={column} onSelectColumn={setColumn} />
          </div>
          <div className="flex h-7 shrink-0 items-center gap-4 border-t px-4 text-[11px] text-muted-foreground">
            <span>{dataset.rowCount.toLocaleString()} rows</span>
            <span>{dataset.columns.length} columns</span>
            <span>Imported {new Date(dataset.importedAt).toLocaleString()}</span>
            <span className="ml-auto font-mono" title="Source fingerprint (SHA-256 of first and last 1 MB)">
              {dataset.fingerprint.partialSha256.slice(0, 12)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
