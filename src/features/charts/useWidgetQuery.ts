import { useEffect, useMemo, useState } from "react";
import { activeDashboard, useDashboard } from "@/features/dashboard/store";
import { useData } from "@/features/data/store";
import { ipc } from "@/lib/ipc";
import { newId } from "@/lib/utils";
import { isAppError, type AppError } from "@/types/errors";
import type { Widget } from "@/types/project";
import type { QueryResult } from "@/types/query";
import { buildQuerySpec } from "./specBuilder";

export type WidgetQueryState =
  | { status: "incomplete"; reason: string }
  | { status: "loading"; result: QueryResult | null }
  | { status: "error"; error: AppError }
  | { status: "ready"; result: QueryResult };

/** Build the widget's QuerySpec and run it; superseded queries are cancelled in DuckDB. */
export function useWidgetQuery(widget: Widget): WidgetQueryState {
  const dataset = useData((s) => s.datasets.find((d) => d.id === widget.datasetId));
  const metrics = useDashboard((s) => s.doc.metrics);
  const globalFilters = useDashboard((s) => activeDashboard(s.doc).globalFilters);

  const built = useMemo(
    () => buildQuerySpec(widget, dataset, metrics, globalFilters),
    [widget, dataset, metrics, globalFilters],
  );
  const key = built.ok ? JSON.stringify(built.spec) : `!${built.reason}`;
  const [state, setState] = useState<WidgetQueryState>({ status: "loading", result: null });

  useEffect(() => {
    if (!built.ok) {
      setState({ status: "incomplete", reason: built.reason });
      return;
    }
    const queryId = newId("q");
    let live = true;
    setState((s) => ({ status: "loading", result: s.status === "ready" ? s.result : null }));
    ipc
      .runQuery(built.spec, queryId)
      .then((result) => live && setState({ status: "ready", result }))
      .catch((e) => {
        if (!live) return;
        setState({ status: "error", error: isAppError(e) ? e : { kind: "internal", message: String(e) } });
      });
    return () => {
      live = false;
      void ipc.cancelQuery(queryId).catch(() => {});
    };
    // `key` captures every input that affects the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
