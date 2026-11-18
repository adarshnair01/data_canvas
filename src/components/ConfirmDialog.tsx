import { AlertTriangle } from "lucide-react";
import { useUi } from "@/app/uiStore";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** In-app replacement for native confirm prompts (web build), e.g. "discard unsaved changes?". */
export function ConfirmDialog() {
  const confirm = useUi((s) => s.confirm);
  const answer = useUi((s) => s.answerConfirm);
  return (
    <Dialog open={!!confirm} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-500" /> {confirm?.title}
          </DialogTitle>
          <DialogDescription>{confirm?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button autoFocus onClick={() => answer(true)}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
