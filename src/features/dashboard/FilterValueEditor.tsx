import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ipc } from "@/lib/ipc";
import { isNumericType, isTemporalType, type CellValue, type ColumnInfo, type ValueCount } from "@/types/dataset";

export type FilterValue =
  | { kind: "in"; values: CellValue[]; exclude?: boolean }
  | { kind: "range"; min?: number | null; max?: number | null }
  | { kind: "dateRange"; from?: string | null; to?: string | null }
  | { kind: "contains"; text: string };

export function defaultFilterFor(col: ColumnInfo): FilterValue {
  if (isNumericType(col.logicalType)) return { kind: "range", min: null, max: null };
  if (isTemporalType(col.logicalType)) return { kind: "dateRange", from: null, to: null };
  return { kind: "in", values: [] };
}

export function describeFilter(f: FilterValue): string {
  switch (f.kind) {
    case "in":
      if (!f.values.length) return "All";
      return `${f.exclude ? "not " : ""}${f.values.length === 1 ? String(f.values[0] ?? "(empty)") : `${f.values.length} values`}`;
    case "range":
      if (f.min == null && f.max == null) return "All";
      return `${f.min ?? "−∞"} – ${f.max ?? "∞"}`;
    case "dateRange":
      if (!f.from && !f.to) return "All";
      return `${f.from || "…"} → ${f.to || "…"}`;
    case "contains":
      return f.text ? `contains “${f.text}”` : "All";
  }
}

const num = (s: string) => (s.trim() === "" || Number.isNaN(Number(s)) ? null : Number(s));

function MultiSelect({
  datasetId,
  column,
  values,
  onChange,
}: {
  datasetId: string;
  column: string;
  values: CellValue[];
  onChange: (v: CellValue[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<ValueCount[] | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      ipc
        .distinctValues(datasetId, column, search || undefined, 200)
        .then((o) => live && setOptions(o))
        .catch(() => live && setOptions([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [datasetId, column, search]);

  const selected = new Set(values.map((v) => JSON.stringify(v)));
  const toggle = (v: CellValue) => {
    const k = JSON.stringify(v);
    onChange(selected.has(k) ? values.filter((x) => JSON.stringify(x) !== k) : [...values, v]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Search className="absolute top-2 left-2 size-3.5 text-muted-foreground" />
        <Input className="h-7 pl-7 text-xs" placeholder="Search values" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="max-h-52 overflow-auto rounded border">
        {options === null && <div className="p-2 text-xs text-muted-foreground">Loading…</div>}
        {options?.length === 0 && <div className="p-2 text-xs text-muted-foreground">No values</div>}
        {options?.map((o) => (
          <label key={JSON.stringify(o.value)} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent">
            <Checkbox checked={selected.has(JSON.stringify(o.value))} onCheckedChange={() => toggle(o.value)} />
            <span className="min-w-0 flex-1 truncate">{o.value === null ? "(empty)" : String(o.value)}</span>
            <span className="text-muted-foreground tabular-nums">{o.count.toLocaleString()}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{values.length ? `${values.length} selected` : "None selected = all"}</span>
        {values.length > 0 && (
          <button className="hover:text-foreground" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

export function FilterValueEditor({
  datasetId,
  column,
  value,
  onChange,
  allowExclude = false,
}: {
  datasetId: string;
  column: ColumnInfo;
  value: FilterValue;
  onChange: (v: FilterValue) => void;
  allowExclude?: boolean;
}) {
  switch (value.kind) {
    case "in":
      return (
        <div className="flex flex-col gap-1.5">
          <MultiSelect datasetId={datasetId} column={column.name} values={value.values} onChange={(values) => onChange({ ...value, values })} />
          {allowExclude && (
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={!!value.exclude} onCheckedChange={(c) => onChange({ ...value, exclude: c === true })} />
              Exclude selected values
            </label>
          )}
        </div>
      );
    case "range":
      return (
        <div className="flex items-center gap-2">
          <Input className="h-7 text-xs" type="number" placeholder="Min" defaultValue={value.min ?? ""} onChange={(e) => onChange({ ...value, min: num(e.target.value) })} />
          <span className="text-xs text-muted-foreground">to</span>
          <Input className="h-7 text-xs" type="number" placeholder="Max" defaultValue={value.max ?? ""} onChange={(e) => onChange({ ...value, max: num(e.target.value) })} />
        </div>
      );
    case "dateRange":
      return (
        <div className="flex items-center gap-2">
          <Input className="h-7 text-xs" type="date" value={value.from ?? ""} onChange={(e) => onChange({ ...value, from: e.target.value || null })} />
          <span className="text-xs text-muted-foreground">to</span>
          <Input className="h-7 text-xs" type="date" value={value.to ?? ""} onChange={(e) => onChange({ ...value, to: e.target.value || null })} />
        </div>
      );
    case "contains":
      return <Input className="h-7 text-xs" placeholder="Text to match" value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />;
  }
}
