import { History } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fileName } from "@/lib/platform";
import { IS_WEB } from "@/lib/target";
import { discardRecovery, recoverProject } from "./actions";
import { useProject } from "./store";

/** Offered at launch when autosave snapshots survived an unclean exit. */
export function RecoveryDialog() {
  const recovery = useProject((s) => s.recovery);
  const busy = useProject((s) => s.busy);
  const setRecovery = useProject((s) => s.setRecovery);

  return (
    <Dialog open={recovery.length > 0} onOpenChange={(open) => !open && setRecovery([])}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-5 text-primary" /> Recover unsaved work?
          </DialogTitle>
          <DialogDescription>
            {IS_WEB
              ? "These projects have unsaved changes that were autosaved in this browser."
              : "DataCanvas did not close normally last time. These projects have autosaved changes."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {recovery.map((r, i) => (
            <motion.div
              key={r.projectId}
              className="flex items-center gap-3 rounded-lg border p-3"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12 + i * 0.06, type: "spring", stiffness: 340, damping: 28 }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.name}</div>
                <div className="truncate text-xs text-muted-foreground" title={r.projectPath ?? undefined}>
                  Autosaved {new Date(r.savedAt).toLocaleString()}
                  {r.projectPath ? ` · ${IS_WEB ? fileName(r.projectPath) : r.projectPath}` : " · never saved"}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void discardRecovery(r.projectId)}>
                Discard
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void recoverProject(r.projectId)}>
                Recover
              </Button>
            </motion.div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
