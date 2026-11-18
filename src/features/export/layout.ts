/** Pure geometry for dashboard exports. Mirrors the react-grid-layout settings in `DashboardGrid`. */

import { GRID_COLS } from "@/features/dashboard/store";
import type { LayoutItem } from "@/types/project";

export interface GridMetrics {
  cols: number;
  rowHeight: number;
  margin: number;
  /** Logical (CSS px) width of the exported dashboard. */
  width: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EXPORT_GRID: GridMetrics = { cols: GRID_COLS, rowHeight: 36, margin: 12, width: 1280 };

/** Height reserved above the grid for the dashboard name. */
export const TITLE_BAR = 44;

/** Padding between a widget card's border and its chart image. */
export const CARD_PADDING = 10;

/** Pixel rectangle of a grid item, matching react-grid-layout's `calcGridItemPosition`. */
export function gridRect(item: LayoutItem, m: GridMetrics = EXPORT_GRID): Rect {
  const colWidth = (m.width - m.margin * (m.cols + 1)) / m.cols;
  return {
    x: Math.round(m.margin + item.x * (colWidth + m.margin)),
    y: Math.round(m.margin + item.y * (m.rowHeight + m.margin)),
    w: Math.round(item.w * colWidth + Math.max(0, item.w - 1) * m.margin),
    h: Math.round(item.h * m.rowHeight + Math.max(0, item.h - 1) * m.margin),
  };
}

/** Size of the grid area (without the title bar). */
export function gridSize(layout: LayoutItem[], m: GridMetrics = EXPORT_GRID): { width: number; height: number } {
  const rows = layout.reduce((max, l) => Math.max(max, l.y + l.h), 0);
  const height = rows ? m.margin + rows * (m.rowHeight + m.margin) : m.margin * 2;
  return { width: m.width, height };
}

/** Inner area of a card where the widget image is drawn. */
export function cardContent(rect: Rect, padding = CARD_PADDING): Rect {
  return {
    x: rect.x + padding,
    y: rect.y + padding,
    w: Math.max(1, rect.w - padding * 2),
    h: Math.max(1, rect.h - padding * 2),
  };
}

/** Scale `src` to fit inside `box`, preserving aspect ratio and centring it. */
export function fitContain(srcW: number, srcH: number, box: Rect): Rect {
  if (srcW <= 0 || srcH <= 0) return { ...box };
  const s = Math.min(box.w / srcW, box.h / srcH);
  const w = srcW * s;
  const h = srcH * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
