import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDashboard } from "@/features/dashboard/store";
import { defaultFilterFor, describeFilter, FilterValueEditor, type FilterValue } from "@/features/dashboard/FilterValueEditor";
import type { DatasetMeta } from "@/types/dataset";
import type { Widget } from "@/types/project";
import { CHART_ROW_CAP, type Filter } from "@/types/query";

/** Widget-level filters and row limit. Sorting lives on each field pill. */
export function WidgetFilters({ widget, dataset }: { widget: Widget; dataset: DatasetMeta }) {
  const [adding, setAdding] = useState<string>("");
  const { setWidgetFilters, updateWidget } = useDashboard.getState();

  const update = (i: number, v: FilterValue) =>
    setWidgetFilters(widget.id, widget.filters.map((f, j) => (j === i ? ({ ...v, field: f.field } as Filter) : f)));

  const add = (field: string) => {
    const col = dataset.columns.find((c) => c.name === field);
    if (!col) return;
    setWidgetFilters(widget.id, [...widget.filters, { ...defaultFilterFor(col), field } as Filter]);
    setAdding("");
  };

  return (
    <div className="flex flex-col gap-3">
      {widget.filters.map((f, i) => {
        const col = dataset.columns.find((c) => c.name === f.field);
        return (
          <div key={i} className="rounded-md border p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="truncate text-xs font-medium">{f.field}</span>
              <span className="truncate text-[11px] text-muted-foreground">{describeFilter(f)}</span>
              {col && col.logicalType === "string" && (
                <Select value={f.kind} onValueChange={(k) => update(i, k === "contains" ? { kind: "contains", text: "" } : { kind: "in", values: [] })}>
                  <SelectTrigger size="sm" className="ml-auto h-6 w-24 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in" className="text-xs">Is one of</SelectItem>
                    <SelectItem value="contains" className="text-xs">Contains</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <button
                className="ml-auto text-muted-foreground hover:text-foreground"
                onClick={() => setWidgetFilters(widget.id, widget.filters.filter((_, j) => j !== i))}
                aria-label="Remove filter"
              >
                <X className="size-3.5" />
              </button>
            </div>
            {col ? (
              <FilterValueEditor datasetId={dataset.id} column={col} value={f} onChange={(v) => update(i, v)} allowExclude />
            ) : (
              <div className="text-xs text-destructive">Column no longer exists</div>
            )}
          </div>
        );
      })}
      <Select value={adding} onValueChange={add}>
        <SelectTrigger size="sm" className="h-8 w-full text-xs">
          <Plus className="size-3.5" />
          <SelectValue placeholder="Add a filter on…" />
        </SelectTrigger>
        <SelectContent>
          {dataset.columns.map((c) => (
            <SelectItem key={c.name} value={c.name} className="text-xs">
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="grid gap-1.5 border-t pt-3">
        <Label className="text-xs">Row limit</Label>
        <Input
          className="h-7 text-xs"
          type="number"
          min={1}
          max={CHART_ROW_CAP}
          placeholder={`Default (max ${CHART_ROW_CAP.toLocaleString()})`}
          value={widget.limit ?? ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            updateWidget(widget.id, { limit: e.target.value && n > 0 ? Math.min(n, CHART_ROW_CAP) : undefined });
          }}
        />
        <span className="text-[11px] text-muted-foreground">Sort by opening a field’s menu in the Data tab.</span>
      </div>
    </div>
  );
}
