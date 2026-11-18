import { describe, expect, it } from "vitest";
import { col, widget } from "@/test/fixtures";
import { columnLabels } from "./actions";
import { fitText } from "./drawWidgets";
import { dataUrlToBytes, safeFileName, withExtension } from "./files";

describe("file helpers", () => {
  it("decodes base64 data URLs to bytes", () => {
    expect(Array.from(dataUrlToBytes("data:image/png;base64,iVBORw=="))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(() => dataUrlToBytes("data:image/png,raw")).toThrow();
    expect(() => dataUrlToBytes("nope")).toThrow();
  });

  it("produces safe file names", () => {
    expect(safeFileName('Q3: "Sales" / Regions?')).toBe("Q3 Sales Regions");
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName("  ")).toBe("Export");
    expect(safeFileName("a\\b\u0000c")).toBe("a b c");
  });

  it("adds missing extensions only", () => {
    expect(withExtension("/tmp/report", "pdf")).toBe("/tmp/report.pdf");
    expect(withExtension("/tmp/report.PDF", "pdf")).toBe("/tmp/report.PDF");
  });
});

describe("columnLabels", () => {
  it("maps QuerySpec ids to chart labels", () => {
    const w = widget("bar", {
      x: col("region", "x1"),
      y: [col("revenue", "y1", { agg: "sum" }), { id: "y2", source: "rows", field: "", agg: "count" }],
    });
    expect(columnLabels(w, [])).toEqual([
      { id: "x1", label: "region" },
      { id: "y1", label: "Sum of revenue" },
      { id: "y2", label: "Row count" },
    ]);
  });
});

describe("fitText", () => {
  const ctx = { measureText: (t: string) => ({ width: t.length * 10 }) as TextMetrics };
  it("ellipsizes to the available width", () => {
    expect(fitText(ctx, "hello", 100)).toBe("hello");
    expect(fitText(ctx, "hello world", 60)).toBe("hello…");
    expect(fitText(ctx, "hello", 5)).toBe("");
  });
});
