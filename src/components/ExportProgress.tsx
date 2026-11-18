import { AnimatePresence, motion } from "motion/react";
import { useUi } from "@/app/uiStore";

/** Floating pill with an indeterminate gradient bar while an export renders. */
export function ExportProgress() {
  const label = useUi((s) => s.exporting);
  return (
    <AnimatePresence>
      {label && (
        <motion.div
          role="status"
          aria-live="polite"
          className="glass fixed bottom-4 left-1/2 z-[95] w-72 -translate-x-1/2 overflow-hidden rounded-full border px-4 py-2 shadow-lg"
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
        >
          <div className="text-center text-xs font-medium">{label}</div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
            <div className="export-progress-bar bg-brand h-full w-1/3 rounded-full" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
