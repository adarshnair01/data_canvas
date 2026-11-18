import { describe, expect, it } from "vitest";
import { cardContent, EXPORT_GRID, fitContain, gridRect, gridSize } from "./layout";

const m = { cols: 12, rowHeight: 36, margin: 12, width: 1248 + 12 };
// colWidth = (1260 - 12 * 13) / 12 = 92

describe("gridRect", () => {
  it("matches react-grid-layout positioning", () => {
    expect(gridRect({ i: "a", x: 0, y: 0, w: 1, h: 1 }, m)).toEqual({ x: 12, y: 12, w: 92, h: 36 });
    expect(gridRect({ i: "b", x: 6, y: 8, w: 6, h: 8 }, m)).toEqual({
      x: 12 + 6 * 104,
      y: 12 + 8 * 48,
      w: 6 * 92 + 5 * 12,
      h: 8 * 36 + 7 * 12,
    });
  });

  it("full-width items span the container minus outer margins", () => {
    const r = gridRect({ i: "t", x: 0, y: 0, w: 12, h: 2 }, EXPORT_GRID);
    expect(r.x).toBe(EXPORT_GRID.margin);
    expect(r.x + r.w).toBe(EXPORT_GRID.width - EXPORT_GRID.margin);
  });
});

describe("gridSize", () => {
  it("covers the lowest item plus margin", () => {
    const layout = [
      { i: "a", x: 0, y: 0, w: 6, h: 8 },
      { i: "b", x: 6, y: 2, w: 6, h: 9 },
    ];
    expect(gridSize(layout, m)).toEqual({ width: 1260, height: 12 + 11 * 48 });
    const bottom = gridRect(layout[1], m);
    expect(bottom.y + bottom.h + m.margin).toBe(gridSize(layout, m).height);
  });

  it("handles empty dashboards", () => {
    expect(gridSize([], m).height).toBe(24);
  });
});

describe("fitContain / cardContent", () => {
  it("letterboxes and centres", () => {
    expect(fitContain(200, 100, { x: 0, y: 0, w: 100, h: 100 })).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    expect(fitContain(100, 200, { x: 10, y: 10, w: 100, h: 100 })).toEqual({ x: 35, y: 10, w: 50, h: 100 });
  });

  it("insets cards and never collapses to zero", () => {
    expect(cardContent({ x: 0, y: 0, w: 100, h: 50 }, 10)).toEqual({ x: 10, y: 10, w: 80, h: 30 });
    expect(cardContent({ x: 0, y: 0, w: 10, h: 10 }, 10)).toMatchObject({ w: 1, h: 1 });
  });
});
