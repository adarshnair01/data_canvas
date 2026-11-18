/** Whole-dashboard PNG: draws each widget's image into one canvas at its grid position. */

import type { LayoutItem } from "@/types/project";
import { cardContent, EXPORT_GRID, fitContain, gridRect, gridSize, TITLE_BAR, type GridMetrics } from "./layout";

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D | null;
  toDataURL(type?: string): string;
}

export interface ImageLike {
  width: number;
  height: number;
}

export interface CanvasDeps {
  createCanvas: (width: number, height: number) => CanvasLike;
  loadImage: (dataUrl: string) => Promise<ImageLike>;
}

export interface Tile {
  /** Matches a layout item's `i`. */
  id: string;
  /** PNG data URL, or `null` when the widget has nothing to show. */
  dataUrl: string | null;
  /** Shown instead of an image. */
  placeholder?: string;
}

export interface CompositeInput {
  title: string;
  subtitle?: string;
  layout: LayoutItem[];
  tiles: Tile[];
}

export interface RasterImage {
  dataUrl: string;
  /** Pixel size of the image (logical size times `scale`). */
  width: number;
  height: number;
}

export const COLORS = {
  page: "#f4f4f5",
  card: "#ffffff",
  border: "#e4e4e7",
  text: "#18181b",
  muted: "#71717a",
};

export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export const browserCanvas: CanvasDeps = {
  createCanvas: (width, height) => {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  },
  loadImage: (dataUrl) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode widget image"));
      img.src = dataUrl;
    }),
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Logical size of the composite for a layout: grid plus title bar. */
export function compositeSize(layout: LayoutItem[], m: GridMetrics = EXPORT_GRID) {
  const g = gridSize(layout, m);
  return { width: g.width, height: g.height + TITLE_BAR };
}

export async function composeDashboard(
  input: CompositeInput,
  deps: CanvasDeps = browserCanvas,
  scale = 2,
  m: GridMetrics = EXPORT_GRID,
): Promise<RasterImage> {
  const size = compositeSize(input.layout, m);
  const canvas = deps.createCanvas(Math.round(size.width * scale), Math.round(size.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  ctx.scale(scale, scale);

  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, size.width, size.height);

  ctx.textBaseline = "middle";
  ctx.fillStyle = COLORS.text;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(input.title, m.margin, TITLE_BAR / 2 + 4);
  if (input.subtitle) {
    const titleWidth = ctx.measureText(input.title).width;
    ctx.fillStyle = COLORS.muted;
    ctx.font = `12px ${FONT}`;
    ctx.fillText(input.subtitle, m.margin + titleWidth + 12, TITLE_BAR / 2 + 5);
  }

  const tiles = new Map(input.tiles.map((t) => [t.id, t]));
  const images = await Promise.all(
    input.layout.map(async (item) => {
      const url = tiles.get(item.i)?.dataUrl;
      return url ? deps.loadImage(url).catch(() => null) : null;
    }),
  );

  input.layout.forEach((item, idx) => {
    const r = gridRect(item, m);
    const rect = { ...r, y: r.y + TITLE_BAR };
    ctx.fillStyle = COLORS.card;
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    roundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, 8);
    ctx.fill();
    ctx.stroke();

    const box = cardContent(rect);
    const img = images[idx];
    if (img) {
      const fit = fitContain(img.width, img.height, box);
      ctx.drawImage(img as CanvasImageSource, fit.x, fit.y, fit.w, fit.h);
    } else {
      ctx.fillStyle = COLORS.muted;
      ctx.font = `12px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(tiles.get(item.i)?.placeholder ?? "No data", box.x + box.w / 2, box.y + box.h / 2);
      ctx.textAlign = "left";
    }
  });

  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}
