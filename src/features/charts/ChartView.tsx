import { useMemo } from "react";
import { AlertTriangle, BarChart3, Loader2 } from "lucide-react";
import { useDashboard } from "@/features/dashboard/store";
import { cn } from "@/lib/utils";
import { ERROR_TITLES } from "@/types/errors";
import type { CalculatedMetric } from "@/types/metrics";
import type { Widget } from "@/types/project";
import { CHART_ROW_CAP, type QueryResult } from "@/types/query";
import { EChart } from "./EChart";
import { useTweenedNumber } from "@/lib/motion";
import { chartOption, formatNumber, kpiModel, tableModel } from "./options";
import { useWidgetQuery } from "./useWidgetQuery";

const TABLE_RENDER_CAP = 1000;

/** Decimals of the final value, kept fixed while tweening so the digits do not jump. */
const kpiDecimals = (v: number) => (Number.isInteger(v) ? 0 : 2);

interface ResultProps {
  widget: Widget;
  result: QueryResult;
  metrics: CalculatedMetric[];
}

function Kpi({ widget, result, metrics }: ResultProps) {
  const k = kpiModel(widget, result, metrics);
  const shown = useTweenedNumber(k.value);
  const { prefix, suffix, decimals } = widget.config.kpi;
  const text = k.value !== null && shown !== null ? `${prefix}${formatNumber(shown, decimals ?? kpiDecimals(k.value))}${suffix}` : k.text;
  return (
    <div className="@container flex h-full flex-col justify-center px-2">
      {widget.config.showTitle && widget.config.title && (
        <div className="text-xs font-medium text-muted-foreground">{widget.config.title}</div>
      )}
      <div
        className="truncate text-[clamp(1rem,16cqi,2.25rem)] leading-tight font-semibold tracking-tight tabular-nums"
        data-selectable
        aria-label={k.text}
      >
        {text}
      </div>
      <div className="truncate text-xs text-muted-foreground">{k.label}</div>
    </div>
  );
}

function ResultTable({ widget, result, metrics }: ResultProps) {
  const t = useMemo(() => tableModel(widget, result, metrics), [widget, result, metrics]);
  return (
    <div className="flex h-full flex-col">
      {widget.config.showTitle && widget.config.title && (
        <div className="pb-1 text-[13px] font-semibold">{widget.config.title}</div>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded border" data-selectable>
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {t.headers.map((h) => (
                <th
                  key={h.id}
                  className={cn("border-b px-2 py-1 font-medium whitespace-nowrap", h.numeric ? "text-right" : "text-left")}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.slice(0, TABLE_RENDER_CAP).map((r, i) => (
              <tr key={i} className="border-b border-border/50 hover:bg-accent/30">
                {r.map((c, j) => (
                  <td key={j} className={cn("px-2 py-0.5 whitespace-nowrap", t.headers[j].numeric && "text-right tabular-nums")}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {t.rows.length > TABLE_RENDER_CAP && (
          <div className="p-2 text-center text-[11px] text-muted-foreground">
            Showing {TABLE_RENDER_CAP.toLocaleString()} of {t.rows.length.toLocaleString()} rows
          </div>
        )}
      </div>
    </div>
  );
}

export function ChartView({ widget }: { widget: Widget }) {
  const q = useWidgetQuery(widget);
  const metrics = useDashboard((s) => s.doc.metrics);
  const result = q.status === "ready" || q.status === "loading" ? q.result : null;

  const option = useMemo(
    () => (result ? chartOption(widget, result, metrics) : null),
    [widget, result, metrics],
  );

  if (q.status === "incomplete") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <BarChart3 className="size-7 opacity-40" />
        <span className="text-xs">{q.reason}</span>
      </div>
    );
  }
  if (q.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-3 text-center" data-selectable>
        <AlertTriangle className="size-5 text-destructive" />
        <span className="text-xs font-medium">{ERROR_TITLES[q.error.kind] ?? "Query failed"}</span>
        <span className="line-clamp-3 text-[11px] text-muted-foreground">{q.error.message}</span>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {q.status === "loading" && (
        <div className={cn("absolute inset-0 z-10 flex items-center justify-center", result && "bg-background/40")}>
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {result && widget.chartType === "kpi" && <Kpi widget={widget} result={result} metrics={metrics} />}
      {result && widget.chartType === "table" && <ResultTable widget={widget} result={result} metrics={metrics} />}
      {result && option && <EChart option={option} exportId={widget.id} />}
      {result?.truncated && (
        <div className="absolute right-1 bottom-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
          First {CHART_ROW_CAP.toLocaleString()} rows
        </div>
      )}
    </div>
  );
}
