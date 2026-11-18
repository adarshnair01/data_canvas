import { useDroppable } from "@dnd-kit/core";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboard } from "@/features/dashboard/store";
import { cn } from "@/lib/utils";
import { ZONES_BY_CHART, type FieldRef, type ZoneDef } from "@/types/chart";
import { isNumericType, isTemporalType, type DatasetMeta } from "@/types/dataset";
import type { Widget } from "@/types/project";
import { AGGREGATIONS, DATE_BUCKETS, type Aggregation, type DateBucket } from "@/types/query";
import { aggLabel, refLabel } from "./specBuilder";

function refsIn(w: Widget, zone: ZoneDef): FieldRef[] {
  const e = w.encoding;
  if (zone.id === "y" || zone.id === "columns") return e[zone.id];
  const r = e[zone.id];
  return r ? [r] : [];
}

function FieldPill({ widget, zone, field: r, dataset }: { widget: Widget; zone: ZoneDef; field: FieldRef; dataset: DatasetMeta }) {
  const metrics = useDashboard((s) => s.doc.metrics);
  const { updateField, removeField, setWidgetSort } = useDashboard.getState();
  const col = r.source === "column" ? dataset.columns.find((c) => c.name === r.field) : undefined;
  const metric = r.source === "metric" ? metrics.find((m) => m.id === r.field) : undefined;
  const raw = widget.chartType === "scatter" && zone.accepts === "measure";
  const canAgg =
    !raw &&
    r.source !== "rows" &&
    !(metric?.isAggregate) &&
    (zone.accepts === "measure" || zone.id === "columns");
  const aggOptions: Aggregation[] =
    col && !isNumericType(col.logicalType)
      ? ["count", "count_distinct", "min", "max"]
      : AGGREGATIONS;
  const canBucket = !!col && isTemporalType(col.logicalType) && zone.accepts !== "measure";
  const sort = widget.sort.find((s) => s.by === r.id);

  const setSort = (dir: "asc" | "desc" | null) =>
    setWidgetSort(widget.id, dir ? [{ by: r.id, dir }] : widget.sort.filter((s) => s.by !== r.id));

  return (
    <div className="flex items-center gap-1 rounded-md border bg-background py-0.5 pr-0.5 pl-2 text-xs shadow-xs">
      <DropdownMenu>
        <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-1 text-left">
          <span className="truncate">{refLabel(r, metrics)}</span>
          {sort && (sort.dir === "asc" ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)}
          <ChevronDown className="ml-auto size-3 shrink-0 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {canAgg && (
            <>
              <DropdownMenuLabel className="text-xs">Aggregation</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={r.agg} onValueChange={(v) => updateField(widget.id, r.id, { agg: v as Aggregation })}>
                {zone.id === "columns" && (
                  <DropdownMenuRadioItem value="none" className="text-xs">
                    None (row values)
                  </DropdownMenuRadioItem>
                )}
                {aggOptions.map((a) => (
                  <DropdownMenuRadioItem key={a} value={a} className="text-xs">
                    {aggLabel(a)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          )}
          {canBucket && (
            <>
              <DropdownMenuLabel className="text-xs">Date bucket</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={r.bucket ?? "none"}
                onValueChange={(v) => updateField(widget.id, r.id, { bucket: v === "none" ? undefined : (v as DateBucket) })}
              >
                <DropdownMenuRadioItem value="none" className="text-xs">
                  Exact value
                </DropdownMenuRadioItem>
                {DATE_BUCKETS.map((b) => (
                  <DropdownMenuRadioItem key={b} value={b} className="text-xs capitalize">
                    {b}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          )}
          {widget.chartType !== "kpi" && widget.chartType !== "scatter" && (
            <>
              <DropdownMenuLabel className="text-xs">Sort</DropdownMenuLabel>
              <DropdownMenuItem className="text-xs" onClick={() => setSort("asc")}>
                <ArrowUp /> Ascending
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs" onClick={() => setSort("desc")}>
                <ArrowDown /> Descending
              </DropdownMenuItem>
              {sort && (
                <DropdownMenuItem className="text-xs" onClick={() => setSort(null)}>
                  <ArrowUpDown /> Default order
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem className="text-xs" variant="destructive" onClick={() => removeField(widget.id, r.id)}>
            <X /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button onClick={() => removeField(widget.id, r.id)} className="rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label="Remove field">
        <X className="size-3" />
      </button>
    </div>
  );
}

function Zone({ widget, zone, dataset, activeAccepts }: { widget: Widget; zone: ZoneDef; dataset: DatasetMeta; activeAccepts: boolean | null }) {
  const { setNodeRef, isOver } = useDroppable({ id: `zone:${zone.id}`, data: { zone: zone.id } });
  const refs = refsIn(widget, zone);
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        {zone.label}
        {zone.required && <span className="text-destructive">*</span>}
        {zone.multiple && <span className="font-normal opacity-60">(multiple)</span>}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-9 flex-col gap-1 rounded-md border border-dashed p-1 transition-colors",
          activeAccepts === true && "border-primary/60 bg-primary/5",
          activeAccepts === false && "opacity-50",
          isOver && activeAccepts && "border-primary bg-primary/10",
        )}
      >
        {refs.map((r) => (
          <FieldPill key={r.id} widget={widget} zone={zone} field={r} dataset={dataset} />
        ))}
        {!refs.length && <div className="px-1.5 py-1 text-[11px] text-muted-foreground/70">Drop a field here</div>}
      </div>
    </div>
  );
}

export function DropZones({
  widget,
  dataset,
  accepts,
}: {
  widget: Widget;
  dataset: DatasetMeta;
  /** While dragging: which zones accept the dragged field. */
  accepts: ((zone: ZoneDef) => boolean) | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      {ZONES_BY_CHART[widget.chartType].map((z) => (
        <Zone key={z.id} widget={widget} zone={z} dataset={dataset} activeAccepts={accepts ? accepts(z) : null} />
      ))}
    </div>
  );
}
