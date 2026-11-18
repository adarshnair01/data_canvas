import { useEffect, useRef } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { useUi } from "@/app/uiStore";
import type { Dashboard } from "@/types/project";
import { GRID_COLS, useDashboard } from "./store";
import { WidgetCard } from "./WidgetCard";

const Grid = WidthProvider(GridLayout);

export function DashboardGrid({ dashboard }: { dashboard: Dashboard }) {
  const setLayout = useDashboard((s) => s.setLayout);
  const selectWidget = useUi((s) => s.selectWidget);
  // Stagger the first appearance of a dashboard; widgets added afterwards animate without delay.
  const settled = useRef(false);
  useEffect(() => {
    settled.current = false;
    const t = setTimeout(() => (settled.current = true), 400);
    return () => clearTimeout(t);
  }, [dashboard.id]);

  // Commit only when a drag/resize finishes so each gesture is one undo step.
  const commit = (layout: Layout[]) => setLayout(layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })));

  return (
    <div className="min-h-full p-1" onClick={(e) => e.target === e.currentTarget && selectWidget(null)}>
      <Grid
        layout={dashboard.layout.map((l) => ({ ...l, minW: 2, minH: 3 }))}
        cols={GRID_COLS}
        rowHeight={36}
        margin={[12, 12]}
        draggableHandle=".widget-handle"
        compactType="vertical"
        onDragStop={commit}
        onResizeStop={commit}
      >
        {dashboard.widgets.map((w, i) => (
          <div key={w.id}>
            <WidgetCard widget={w} enterDelay={settled.current ? 0 : Math.min(i * 0.05, 0.4)} />
          </div>
        ))}
      </Grid>
    </div>
  );
}
