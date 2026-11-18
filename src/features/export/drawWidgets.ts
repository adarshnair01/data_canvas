/** Canvas drawing for widgets that are plain DOM on screen (KPI cards and tables). */

import type { KpiModel, TableModel } from "@/features/charts/options";
import { COLORS, FONT } from "./composite";

type Ctx = CanvasRenderingContext2D;

/** Truncate `text` with an ellipsis so it fits in `maxWidth`. */
export function fitText(ctx: Pick<Ctx, "measureText">, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo ? text.slice(0, lo) + "…" : "";
}

export function drawKpi(ctx: Ctx, model: KpiModel, title: string | undefined, w: number, h: number) {
  ctx.fillStyle = COLORS.card;
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  const lines = (title ? 1 : 0) + 2;
  const valueSize = Math.max(16, Math.min(40, w / 6, h / (lines + 0.5)));
  let y = h / 2 - (title ? valueSize * 0.6 : 0);
  if (title) {
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(fitText(ctx, title, w - 8), 4, y - valueSize * 0.9);
  }
  ctx.font = `600 ${valueSize}px ${FONT}`;
  ctx.fillStyle = COLORS.text;
  ctx.fillText(fitText(ctx, model.text, w - 8), 4, y);
  y += valueSize * 0.85;
  ctx.font = `12px ${FONT}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(fitText(ctx, model.label, w - 8), 4, y);
}

const ROW_H = 20;
const CELL_PAD = 6;

export function drawTable(ctx: Ctx, model: TableModel, title: string | undefined, w: number, h: number) {
  ctx.fillStyle = COLORS.card;
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  let top = 0;
  if (title) {
    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(fitText(ctx, title, w), 0, 10);
    top = 24;
  }
  const n = model.headers.length;
  if (!n) return;

  ctx.font = `11px ${FONT}`;
  const sample = model.rows.slice(0, 50);
  const natural = model.headers.map((hd, i) =>
    Math.max(ctx.measureText(hd.label).width, ...sample.map((r) => ctx.measureText(r[i] ?? "").width)) + CELL_PAD * 2,
  );
  const total = natural.reduce((a, b) => a + b, 0);
  const widths = total <= w ? natural.map((x) => x + (w - total) / n) : natural.map((x) => (x / total) * w);

  const capacity = Math.max(0, Math.floor((h - top - ROW_H) / ROW_H));
  const overflow = model.rows.length > capacity;
  const rows = model.rows.slice(0, overflow ? Math.max(0, capacity - 1) : capacity);

  ctx.fillStyle = "#f4f4f5";
  ctx.fillRect(0, top, w, ROW_H);
  const drawRow = (cells: string[], y: number, bold: boolean) => {
    let x = 0;
    ctx.font = `${bold ? "500 " : ""}11px ${FONT}`;
    ctx.fillStyle = bold ? COLORS.text : "#27272a";
    cells.forEach((c, i) => {
      const cw = widths[i];
      const text = fitText(ctx, c ?? "", cw - CELL_PAD * 2);
      const numeric = model.headers[i].numeric;
      ctx.textAlign = numeric ? "right" : "left";
      ctx.fillText(text, numeric ? x + cw - CELL_PAD : x + CELL_PAD, y + ROW_H / 2);
      x += cw;
    });
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(0, y + ROW_H - 1, w, 1);
  };
  drawRow(
    model.headers.map((hd) => hd.label),
    top,
    true,
  );
  rows.forEach((r, i) => drawRow(r, top + ROW_H * (i + 1), false));
  if (overflow && capacity > 0) {
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "center";
    const remaining = model.rows.length - rows.length;
    ctx.fillText(`+ ${remaining.toLocaleString()} more rows`, w / 2, top + ROW_H * (rows.length + 1) + ROW_H / 2);
    ctx.textAlign = "left";
  }
}
