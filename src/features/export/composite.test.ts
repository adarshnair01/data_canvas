import { describe, expect, it, vi } from "vitest";
import { composeDashboard, compositeSize, type CanvasDeps, type CanvasLike } from "./composite";
import { cardContent, EXPORT_GRID, fitContain, gridRect, TITLE_BAR } from "./layout";

/** Records 2D context calls so composites can be checked without a real canvas. */
function fakeCanvas() {
  const calls: { op: string; args: unknown[] }[] = [];
  const ctx = new Proxy(
    {
      measureText: (t: string) => ({ width: t.length * 7 }),
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => calls.push({ op: prop, args });
      },
      set(target, prop: string, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  const made: CanvasLike[] = [];
  const deps: CanvasDeps = {
    createCanvas: (width, height) => {
      const c: CanvasLike = {
        width,
        height,
        getContext: () => ctx as unknown as CanvasRenderingContext2D,
        toDataURL: () => "data:image/png;base64,Q09NUE9TSVRF",
      };
      made.push(c);
      return c;
    },
    loadImage: vi.fn(async (url: string) => {
      if (url.includes("broken")) throw new Error("decode");
      return { width: 400, height: 200, url };
    }),
  };
  return { calls, deps, made };
}

const layout = [
  { i: "w1", x: 0, y: 0, w: 6, h: 8 },
  { i: "w2", x: 6, y: 0, w: 6, h: 8 },
  { i: "w3", x: 0, y: 8, w: 12, h: 4 },
];

describe("composeDashboard", () => {
  it("draws each widget image at its grid slot on a scaled canvas", async () => {
    const { calls, deps, made } = fakeCanvas();
    const out = await composeDashboard(
      {
        title: "Sales",
        subtitle: "Q3 · Nov 18",
        layout,
        tiles: [
          { id: "w1", dataUrl: "data:image/png;base64,AAA" },
          { id: "w2", dataUrl: null, placeholder: "Add a field to the X axis" },
          { id: "w3", dataUrl: "data:image/png;base64,broken" },
        ],
      },
      deps,
      2,
    );

    const size = compositeSize(layout);
    expect(made[0].width).toBe(size.width * 2);
    expect(made[0].height).toBe(size.height * 2);
    expect(out).toEqual({ dataUrl: "data:image/png;base64,Q09NUE9TSVRF", width: size.width * 2, height: size.height * 2 });
    expect(calls.find((c) => c.op === "scale")?.args).toEqual([2, 2]);

    const texts = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(texts).toEqual(["Sales", "Q3 · Nov 18", "Add a field to the X axis", "No data"]);

    const draws = calls.filter((c) => c.op === "drawImage");
    expect(draws).toHaveLength(1);
    const slot = gridRect(layout[0], EXPORT_GRID);
    const fit = fitContain(400, 200, cardContent({ ...slot, y: slot.y + TITLE_BAR }));
    expect(draws[0].args.slice(1)).toEqual([fit.x, fit.y, fit.w, fit.h]);
    expect(deps.loadImage).toHaveBeenCalledTimes(2);
  });

  it("fails clearly without a 2D context", async () => {
    const { deps } = fakeCanvas();
    const noCtx: CanvasDeps = {
      ...deps,
      createCanvas: (w, h) => ({ width: w, height: h, getContext: () => null, toDataURL: () => "" }),
    };
    await expect(composeDashboard({ title: "x", layout, tiles: [] }, noCtx)).rejects.toThrow(/Canvas 2D/);
  });
});
