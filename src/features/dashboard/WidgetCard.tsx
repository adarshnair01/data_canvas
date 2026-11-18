import { useState } from "react";
import { Copy, GripVertical, Pencil, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useUi } from "@/app/uiStore";
import { ChartView } from "@/features/charts/ChartView";
import { useData } from "@/features/data/store";
import { cn } from "@/lib/utils";
import { CHART_TYPES } from "@/types/chart";
import type { Widget } from "@/types/project";
import { useDashboard } from "./store";

/** `enterDelay` staggers cards when a dashboard first appears; widgets added later pop in at once. */
export function WidgetCard({ widget, enterDelay = 0 }: { widget: Widget; enterDelay?: number }) {
  const selected = useUi((s) => s.selectedWidgetId === widget.id);
  const selectWidget = useUi((s) => s.selectWidget);
  const datasetName = useData((s) => s.datasets.find((d) => d.id === widget.datasetId)?.name);
  const { duplicateWidget, removeWidget } = useDashboard.getState();
  const typeLabel = CHART_TYPES.find((c) => c.type === widget.chartType)?.label;
  const [leaving, setLeaving] = useState(false);

  return (
    <motion.div
      onMouseDown={() => selectWidget(widget.id)}
      initial={{ opacity: 0, scale: 0.95, y: 10 }}
      animate={leaving ? { opacity: 0, scale: 0.92 } : { opacity: 1, scale: 1, y: 0 }}
      transition={
        leaving ? { duration: 0.16, ease: "easeIn" } : { type: "spring", stiffness: 360, damping: 28, delay: enterDelay }
      }
      onAnimationComplete={() => leaving && removeWidget(widget.id)}
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-lg border bg-card shadow-xs transition-shadow hover:shadow-md",
        selected && "ring-2 ring-primary/60",
        leaving && "pointer-events-none",
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-1 px-1.5 text-[11px] text-muted-foreground">
        <div className="widget-handle flex cursor-grab items-center active:cursor-grabbing" title="Drag to move">
          <GripVertical className="size-3.5" />
        </div>
        <span className="truncate">
          {typeLabel}
          {datasetName ? ` · ${datasetName}` : ""}
        </span>
        <div className="ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100">
          <button className="rounded p-1 hover:bg-accent hover:text-foreground" onClick={() => selectWidget(widget.id)} aria-label="Edit">
            <Pencil className="size-3" />
          </button>
          <button
            className="rounded p-1 hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              const id = duplicateWidget(widget.id);
              if (id) selectWidget(id);
            }}
            aria-label="Duplicate"
          >
            <Copy className="size-3" />
          </button>
          <button
            className="rounded p-1 hover:bg-destructive/10 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              if (selected) selectWidget(null);
              setLeaving(true);
            }}
            aria-label="Delete"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-3 pb-2">
        <ChartView widget={widget} />
      </div>
    </motion.div>
  );
}
