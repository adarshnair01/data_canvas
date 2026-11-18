import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { isNumericType, type CellValue, type DatasetMeta } from "@/types/dataset";
import { errorMessage } from "@/types/errors";
import type { SortDir } from "@/types/query";
import { TypeBadge } from "./TypeBadge";

const PAGE = 200;
const ROW_H = 28;
const COL_W = 168;
const INDEX_W = 64;

function display(v: CellValue | undefined): string {
  if (v === null) return "NULL";
  if (v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

interface Props {
  dataset: DatasetMeta;
  selectedColumn: string | null;
  onSelectColumn: (name: string) => void;
}

/** Virtualised, paged (LIMIT/OFFSET) preview with server-side sort. */
export function PreviewGrid({ dataset, selectedColumn, onSelectColumn }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<{ column: string; dir: SortDir } | null>(null);
  const [pages, setPages] = useState<Map<number, CellValue[][]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(new Set<number>());
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    inflight.current.clear();
    setPages(new Map());
    setError(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [dataset.id, dataset.typeOverrides, sort]);

  const loadPage = useCallback(
    (page: number) => {
      if (inflight.current.has(page)) return;
      inflight.current.add(page);
      const gen = generation.current;
      ipc
        .previewDataset(dataset.id, page * PAGE, PAGE, sort)
        .then((res) => {
          if (gen !== generation.current) return;
          setPages((prev) => new Map(prev).set(page, res.rows));
        })
        .catch((e) => gen === generation.current && setError(errorMessage(e)));
    },
    [dataset.id, sort],
  );

  const virtualizer = useVirtualizer({
    count: dataset.rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();

  useEffect(() => {
    if (!items.length) return;
    const first = Math.floor(items[0].index / PAGE);
    const last = Math.floor(items[items.length - 1].index / PAGE);
    for (let p = first; p <= last; p++) if (!pages.has(p)) loadPage(p);
  }, [items, pages, loadPage]);

  const toggleSort = (column: string) =>
    setSort((s) =>
      s?.column !== column ? { column, dir: "asc" } : s.dir === "asc" ? { column, dir: "desc" } : null,
    );

  const width = INDEX_W + dataset.columns.length * COL_W;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {error && <div className="border-b bg-destructive/5 px-3 py-1.5 text-xs text-destructive">{error}</div>}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto" data-selectable>
        <div style={{ width, height: virtualizer.getTotalSize() + ROW_H }} className="relative">
          <div className="sticky top-0 z-10 flex border-b bg-muted/95 backdrop-blur" style={{ width, height: ROW_H + 8 }}>
            <div className="sticky left-0 z-10 shrink-0 border-r bg-muted" style={{ width: INDEX_W }} />
            {dataset.columns.map((c) => (
              <button
                key={c.name}
                onClick={() => onSelectColumn(c.name)}
                onDoubleClick={() => toggleSort(c.name)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 border-r px-2 text-left text-xs font-medium hover:bg-accent",
                  selectedColumn === c.name && "bg-accent",
                )}
                style={{ width: COL_W }}
                title={`${c.name} (${c.duckType}) — double-click to sort`}
              >
                <TypeBadge type={c.logicalType} />
                <span className="truncate">{c.name}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSort(c.name);
                  }}
                  className={cn("ml-auto shrink-0 rounded p-0.5 hover:bg-background", sort?.column !== c.name && "opacity-30")}
                  aria-label={`Sort by ${c.name}`}
                >
                  {sort?.column === c.name && sort.dir === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
                </span>
              </button>
            ))}
          </div>
          {items.map((vi) => {
            const row = pages.get(Math.floor(vi.index / PAGE))?.[vi.index % PAGE];
            return (
              <div
                key={vi.key}
                className="absolute left-0 flex border-b border-border/60 text-xs hover:bg-accent/30"
                style={{ top: vi.start + ROW_H + 8, height: ROW_H, width }}
              >
                <div
                  className="sticky left-0 shrink-0 border-r bg-background px-2 text-right leading-7 text-muted-foreground tabular-nums"
                  style={{ width: INDEX_W }}
                >
                  {vi.index + 1}
                </div>
                {dataset.columns.map((c, ci) => {
                  const v = row?.[ci];
                  return (
                    <div
                      key={c.name}
                      className={cn(
                        "shrink-0 truncate border-r border-border/40 px-2 leading-7",
                        isNumericType(c.logicalType) && "text-right tabular-nums",
                        v === null && "text-muted-foreground/60 italic",
                        !row && "animate-pulse text-transparent",
                      )}
                      style={{ width: COL_W }}
                    >
                      {row ? display(v) : "…"}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
