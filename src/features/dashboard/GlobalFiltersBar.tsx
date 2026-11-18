import { useMemo, useState } from "react";
import { Filter as FilterIcon, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useData } from "@/features/data/store";
import type { ColumnInfo, DatasetMeta } from "@/types/dataset";
import type { GlobalFilter, NewGlobalFilter } from "@/types/project";
import { defaultFilterFor, describeFilter, FilterValueEditor, type FilterValue } from "./FilterValueEditor";
import { useDashboard } from "./store";

function resolve(g: Pick<GlobalFilter, "field" | "datasetId">, datasets: DatasetMeta[]): { ds: DatasetMeta; col: ColumnInfo } | null {
  for (const ds of datasets) {
    if (g.datasetId && ds.id !== g.datasetId) continue;
    const col = ds.columns.find((c) => c.name === g.field);
    if (col) return { ds, col };
  }
  return null;
}

function FilterChip({ filter }: { filter: GlobalFilter }) {
  const datasets = useData((s) => s.datasets);
  const { updateGlobalFilter, removeGlobalFilter } = useDashboard.getState();
  const target = resolve(filter, datasets);
  const scope = filter.datasetId ? datasets.find((d) => d.id === filter.datasetId)?.name : "all datasets";
  const value = filter as unknown as FilterValue;
  const active = describeFilter(value) !== "All";

  return (
    <Popover>
      <div className="flex items-center rounded-full border bg-background text-xs shadow-xs">
        <PopoverTrigger className="flex items-center gap-1.5 py-1 pr-1 pl-2.5">
          <span className="font-medium">{filter.label || filter.field}</span>
          <span className={active ? "text-primary" : "text-muted-foreground"}>{describeFilter(value)}</span>
        </PopoverTrigger>
        <button className="mr-1 rounded-full p-0.5 text-muted-foreground hover:bg-accent" onClick={() => removeGlobalFilter(filter.id)} aria-label="Remove filter">
          <X className="size-3" />
        </button>
      </div>
      <PopoverContent align="start" className="w-72">
        <div className="mb-2 text-xs text-muted-foreground">
          Applies to every chart on {scope} with a <span className="font-medium text-foreground">{filter.field}</span> column.
        </div>
        {target ? (
          <FilterValueEditor
            datasetId={target.ds.id}
            column={target.col}
            value={value}
            onChange={(v) => updateGlobalFilter(filter.id, v as Partial<GlobalFilter>)}
          />
        ) : (
          <div className="text-xs text-destructive">No dataset has this column.</div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AddFilter() {
  const datasets = useData((s) => s.datasets);
  const addGlobalFilter = useDashboard((s) => s.addGlobalFilter);
  const [open, setOpen] = useState(false);
  const [dsId, setDsId] = useState<string>("");
  const [onlyThis, setOnlyThis] = useState(false);
  const ds = datasets.find((d) => d.id === dsId) ?? datasets[0];
  const columns = useMemo(() => ds?.columns ?? [], [ds]);

  const add = (field: string) => {
    const col = columns.find((c) => c.name === field);
    if (!col || !ds) return;
    const v = defaultFilterFor(col);
    if (v.kind === "contains") return;
    addGlobalFilter({ field, datasetId: onlyThis ? ds.id : null, ...v } as NewGlobalFilter);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" disabled={!datasets.length}>
          <Plus /> Add filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="grid gap-2">
          <Select value={ds?.id ?? ""} onValueChange={setDsId}>
            <SelectTrigger size="sm" className="h-8 w-full text-xs">
              <SelectValue placeholder="Dataset" />
            </SelectTrigger>
            <SelectContent>
              {datasets.map((d) => (
                <SelectItem key={d.id} value={d.id} className="text-xs">
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="max-h-56 overflow-auto rounded border">
            {columns.map((c) => (
              <button key={c.name} onClick={() => add(c.name)} className="flex w-full items-center justify-between px-2 py-1 text-left text-xs hover:bg-accent">
                <span className="truncate">{c.name}</span>
                <span className="text-[10px] text-muted-foreground">{c.logicalType}</span>
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={onlyThis} onCheckedChange={(v) => setOnlyThis(v === true)} />
            Only charts using this dataset
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function GlobalFiltersBar({ filters }: { filters: GlobalFilter[] }) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
      <FilterIcon className="size-3.5 text-muted-foreground" />
      {filters.length === 0 && <span className="text-xs text-muted-foreground">No dashboard filters</span>}
      {filters.map((f) => (
        <FilterChip key={f.id} filter={f} />
      ))}
      <AddFilter />
    </div>
  );
}
