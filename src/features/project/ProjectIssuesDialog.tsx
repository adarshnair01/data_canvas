import { useState } from "react";
import { AlertTriangle, FileQuestion, FolderSearch, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DatasetLoad, SchemaDiff } from "@/types/project";
import { describeChange, keepDataset, relocateDataset, reloadSource } from "./actions";
import { useProject } from "./store";

function SchemaDetails({ diff }: { diff: SchemaDiff }) {
  if (!diff.added.length && !diff.removed.length && !diff.typeChanged.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
      {diff.added.map((c) => (
        <li key={`+${c}`} className="text-emerald-700">+ {c}</li>
      ))}
      {diff.removed.map((c) => (
        <li key={`-${c}`} className="text-destructive">− {c}</li>
      ))}
      {diff.typeChanged.map((t) => (
        <li key={`~${t.name}`} className="text-amber-700">
          ~ {t.name}: {t.before} → {t.after}
        </li>
      ))}
    </ul>
  );
}

function IssueRow({ issue }: { issue: DatasetLoad }) {
  const [working, setWorking] = useState(false);
  const run = async (f: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await f();
    } finally {
      setWorking(false);
    }
  };

  const locate = (
    <Button size="sm" variant="outline" disabled={working} onClick={() => void run(() => relocateDataset(issue.id))}>
      <FolderSearch /> Locate file…
    </Button>
  );

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-start gap-2.5">
        {issue.status === "changed" ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        ) : (
          <FileQuestion className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{issue.name}</div>
          {issue.status === "missing" && (
            <>
              <div className="text-xs text-muted-foreground">Source file not found. Looked in:</div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground" data-selectable>
                {issue.searched.map((p) => (
                  <li key={p} className="truncate" title={p}>{p}</li>
                ))}
              </ul>
            </>
          )}
          {issue.status === "failed" && (
            <div className="text-xs text-destructive" data-selectable>{issue.message}</div>
          )}
          {issue.status === "changed" && (
            <>
              <div className="text-xs text-muted-foreground">
                The source file changed since the project was saved: {describeChange(issue.change)}.
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {issue.loadedFrom === "embedded"
                  ? "Using the copy saved in the project. Refresh re-reads the source file."
                  : "Charts show the current file. Refresh records the new version in the project; Keep leaves the project as saved."}
              </div>
              {issue.change.schema && <SchemaDetails diff={issue.change.schema} />}
            </>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        {issue.status === "changed" ? (
          <>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => keepDataset(issue.id)}>
              Keep
            </Button>
            <Button size="sm" disabled={working} onClick={() => void run(() => reloadSource(issue.id))}>
              <RefreshCw /> Refresh
            </Button>
          </>
        ) : (
          locate
        )}
      </div>
    </div>
  );
}

/** Shown after opening a project whose linked files are missing or have changed. */
export function ProjectIssuesDialog() {
  const issues = useProject((s) => s.issues);
  const setIssues = useProject((s) => s.setIssues);
  const unresolvedMissing = issues.some((i) => i.status !== "changed");

  return (
    <Dialog open={issues.length > 0} onOpenChange={(open) => !open && setIssues([])}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Check data sources</DialogTitle>
          <DialogDescription>
            Some datasets in this project need attention before every chart can load.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-auto">
          {issues.map((i) => (
            <IssueRow key={i.id} issue={i} />
          ))}
        </div>
        <DialogFooter className="items-center">
          {unresolvedMissing && (
            <span className="mr-auto text-xs text-muted-foreground">
              Datasets you skip stay in the project and can be located later.
            </span>
          )}
          <Button variant="outline" onClick={() => setIssues([])}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
