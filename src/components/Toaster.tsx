import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useUi } from "@/app/uiStore";
import { cn } from "@/lib/utils";

export function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-96 flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = t.tone === "error" ? XCircle : t.tone === "success" ? CheckCircle2 : Info;
          return (
            <motion.div
              key={t.id}
              layout
              role="status"
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 60, transition: { duration: 0.18 } }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className={cn(
                "glass pointer-events-auto relative flex gap-3 overflow-hidden rounded-lg border p-3 shadow-lg",
                t.tone === "error" && "border-destructive/40",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute inset-y-0 left-0 w-1",
                  t.tone === "error" ? "bg-destructive" : t.tone === "success" ? "bg-emerald-500" : "bg-brand",
                )}
              />
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  t.tone === "error"
                    ? "text-destructive"
                    : t.tone === "success"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-primary",
                )}
              />
              <div className="min-w-0 flex-1" data-selectable>
                <div className="text-sm font-medium">{t.title}</div>
                {t.description && <div className="mt-0.5 text-xs break-words text-muted-foreground">{t.description}</div>}
              </div>
              <button className="text-muted-foreground hover:text-foreground" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X className="size-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
