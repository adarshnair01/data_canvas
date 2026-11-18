import { useEffect, useState } from "react";
import { CheckCircle2, FunctionSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { useUi } from "@/app/uiStore";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useData } from "@/features/data/store";
import { ipc } from "@/lib/ipc";
import { isAppError, type AppError } from "@/types/errors";
import { METRIC_FUNCTIONS, type ParsedExpression } from "@/types/metrics";
import { useDashboard } from "./store";

interface Draft {
  id: string | null;
  name: string;
  datasetId: string;
  expression: string;
}

/** Calculated metrics: expressions are validated by the Rust parser, never run as SQL here. */
export function MetricsDialog() {
  const open = useUi((s) => s.metricsOpen);
  const setOpen = useUi((s) => s.setMetricsOpen);
  const datasets = useData((s) => s.datasets);
  const metrics = useDashboard((s) => s.doc.metrics);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [parsed, setParsed] = useState<ParsedExpression | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    if (!open) setDraft(null);
  }, [open]);

  useEffect(() => {
    setParsed(null);
    setError(null);
    if (!draft?.datasetId || !draft.expression.trim()) return;
    let live = true;
    const t = setTimeout(() => {
      ipc
        .parseMetricExpression(draft.datasetId, draft.expression)
        .then((p) => live && setParsed(p))
        .catch((e) => live && setError(isAppError(e) ? e : { kind: "internal", message: String(e) }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [draft?.datasetId, draft?.expression]);

  const save = () => {
    if (!draft || !parsed || !draft.name.trim()) return;
    const s = useDashboard.getState();
    const data = { name: draft.name.trim(), datasetId: draft.datasetId, expression: draft.expression.trim(), isAggregate: parsed.isAggregate };
    if (draft.id) s.updateMetric(draft.id, data);
    else s.addMetric(data);
    setDraft(null);
  };

  const dataset = datasets.find((d) => d.id === draft?.datasetId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Calculated metrics</DialogTitle>
          <DialogDescription>
            Combine columns with arithmetic, IF, ROUND, ABS, COALESCE and aggregates. Use [Square brackets] for column names with spaces.
          </DialogDescription>
        </DialogHeader>

        {!draft && (
          <div className="flex flex-col gap-2">
            {metrics.length === 0 && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No calculated metrics yet.</div>}
            {metrics.map((m) => (
              <div key={m.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                <FunctionSquare className="size-4 text-violet-600" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{m.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground" data-selectable>
                    {m.expression}
                  </div>
                </div>
                <span className="text-[11px] text-muted-foreground">{datasets.find((d) => d.id === m.datasetId)?.name ?? "missing dataset"}</span>
                <Button size="icon-sm" variant="ghost" onClick={() => setDraft({ id: m.id, name: m.name, datasetId: m.datasetId, expression: m.expression })} aria-label="Edit">
                  <Pencil />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => useDashboard.getState().removeMetric(m.id)} aria-label="Delete">
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              className="self-start"
              size="sm"
              disabled={!datasets.length}
              onClick={() => setDraft({ id: null, name: "", datasetId: useData.getState().selectedId ?? datasets[0]?.id ?? "", expression: "" })}
            >
              <Plus /> New metric
            </Button>
          </div>
        )}

        {draft && (
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <Input value={draft.name} placeholder="e.g. Average order value" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label>Dataset</Label>
                <Select value={draft.datasetId} onValueChange={(v) => setDraft({ ...draft, datasetId: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {datasets.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Expression</Label>
              <textarea
                className="min-h-20 rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                spellCheck={false}
                placeholder="SUM(revenue) / COUNT(*)"
                value={draft.expression}
                onChange={(e) => setDraft({ ...draft, expression: e.target.value })}
              />
              <div className="min-h-5 text-xs" data-selectable>
                {error && (
                  <span className="text-destructive">
                    {error.message}
                    {error.position !== undefined && error.position > 0 && ` (at character ${error.position + 1})`}
                  </span>
                )}
                {parsed && (
                  <span className="flex items-center gap-1 text-emerald-700">
                    <CheckCircle2 className="size-3.5" />
                    Valid {parsed.isAggregate ? "aggregate" : "row-level"} expression
                    {!parsed.isAggregate && " — it will be summed by default in charts"}
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="mb-1 font-medium text-muted-foreground">Functions</div>
                <div className="flex flex-wrap gap-1">
                  {METRIC_FUNCTIONS.map((f) => (
                    <code key={f} className="rounded bg-muted px-1.5 py-0.5">
                      {f}
                    </code>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 font-medium text-muted-foreground">Columns</div>
                <div className="flex max-h-24 flex-wrap gap-1 overflow-auto">
                  {dataset?.columns.map((c) => (
                    <button
                      key={c.name}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono hover:bg-accent"
                      onClick={() => {
                        const token = /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? c.name : `[${c.name}]`;
                        setDraft({ ...draft, expression: `${draft.expression}${draft.expression && !draft.expression.endsWith(" ") ? " " : ""}${token}` });
                      }}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft(null)}>
                Back
              </Button>
              <Button onClick={save} disabled={!parsed || !draft.name.trim()}>
                {draft.id ? "Save metric" : "Add metric"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
