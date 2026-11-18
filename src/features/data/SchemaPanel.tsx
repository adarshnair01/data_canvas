import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "@/app/uiStore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { ColumnStats, DatasetMeta, LogicalType } from "@/types/dataset";
import { errorMessage } from "@/types/errors";
import { useData } from "./store";
import { TYPE_LABELS, TypeBadge } from "./TypeBadge";

const OVERRIDABLE: LogicalType[] = ["string", "integer", "float", "boolean", "date", "timestamp"];

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return String(v);
}

interface Props {
  dataset: DatasetMeta;
  selectedColumn: string | null;
  onSelectColumn: (name: string) => void;
}

export function SchemaPanel({ dataset, selectedColumn, onSelectColumn }: Props) {
  const [stats, setStats] = useState<ColumnStats | null>(null);
  const setColumnType = useData((s) => s.setColumnType);
  const column = dataset.columns.find((c) => c.name === selectedColumn) ?? null;

  useEffect(() => {
    setStats(null);
    if (!column) return;
    let live = true;
    ipc
      .columnStats(dataset.id, column.name)
      .then((s) => live && setStats(s))
      .catch((e) => live && toast({ tone: "error", title: "Stats failed", description: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [dataset.id, column?.name, column?.logicalType]);

  const changeType = async (name: string, value: string) => {
    const col = dataset.columns.find((c) => c.name === name);
    if (!col || value === col.logicalType) return;
    try {
      await setColumnType(dataset.id, name, value === "__reset" ? null : (value as LogicalType));
    } catch (e) {
      toast({ tone: "error", title: "Could not change type", description: errorMessage(e) });
    }
  };

  return (
    <div className="flex w-80 shrink-0 flex-col border-l bg-card">
      <div className="border-b px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Columns ({dataset.columns.length})
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {dataset.columns.map((c) => (
          <div
            key={c.name}
            onClick={() => onSelectColumn(c.name)}
            className={cn(
              "flex cursor-default items-center gap-2 border-b border-border/50 px-3 py-1.5",
              selectedColumn === c.name ? "bg-accent" : "hover:bg-accent/40",
            )}
          >
            <TypeBadge type={c.logicalType} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium" title={c.name}>
                {c.name}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {c.nullCount.toLocaleString()} null · ~{c.distinctEstimate.toLocaleString()} distinct
              </div>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <Select value={c.logicalType} onValueChange={(v) => void changeType(c.name, v)}>
                <SelectTrigger size="sm" className="h-7 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OVERRIDABLE.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs">
                      {TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                  {c.originalType && (
                    <SelectItem value="__reset" className="text-xs">
                      <RotateCcw className="size-3" /> Reset ({c.originalType})
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        ))}
      </div>
      {column && (
        <div className="max-h-[45%] overflow-auto border-t p-3" data-selectable>
          <div className="flex items-center gap-2">
            <TypeBadge type={column.logicalType} />
            <span className="truncate text-sm font-semibold">{column.name}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{column.duckType}</span>
          </div>
          {column.originalType && (
            <div className="mt-1 text-[11px] text-amber-700">
              Overridden from {column.originalType}. Values that cannot be converted become NULL.
            </div>
          )}
          {!stats && <div className="mt-3 text-xs text-muted-foreground">Computing statistics…</div>}
          {stats && (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Rows</dt>
                <dd className="text-right tabular-nums">{fmt(stats.rowCount)}</dd>
                <dt className="text-muted-foreground">Nulls</dt>
                <dd className="text-right tabular-nums">{fmt(stats.nullCount)}</dd>
                <dt className="text-muted-foreground">Distinct (approx.)</dt>
                <dd className="text-right tabular-nums">{fmt(stats.distinctCount)}</dd>
                <dt className="text-muted-foreground">Min</dt>
                <dd className="truncate text-right tabular-nums">{fmt(stats.min)}</dd>
                <dt className="text-muted-foreground">Max</dt>
                <dd className="truncate text-right tabular-nums">{fmt(stats.max)}</dd>
                {stats.mean !== null && (
                  <>
                    <dt className="text-muted-foreground">Mean</dt>
                    <dd className="text-right tabular-nums">{fmt(stats.mean)}</dd>
                  </>
                )}
              </dl>
              <div className="mt-3 text-[11px] font-semibold text-muted-foreground uppercase">Top values</div>
              <div className="mt-1 flex flex-col gap-1">
                {stats.topValues.map((tv, i) => {
                  const pct = stats.rowCount ? (tv.count / stats.rowCount) * 100 : 0;
                  return (
                    <div key={i} className="relative overflow-hidden rounded bg-muted/50 px-2 py-0.5 text-xs">
                      <div className="absolute inset-y-0 left-0 bg-primary/15" style={{ width: `${pct}%` }} />
                      <div className="relative flex justify-between gap-2">
                        <span className="truncate">{fmt(tv.value)}</span>
                        <span className="text-muted-foreground tabular-nums">{tv.count.toLocaleString()}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
