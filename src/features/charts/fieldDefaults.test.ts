import { describe, expect, it } from "vitest";
import { sales } from "@/test/fixtures";
import type { CalculatedMetric } from "@/types/metrics";
import { autoZone, defaultRefFor } from "./fieldDefaults";

const agg: CalculatedMetric = { id: "m1", name: "AOV", datasetId: "ds1", expression: "SUM(revenue)/COUNT(*)", isAggregate: true };
const row: CalculatedMetric = { id: "m2", name: "Total", datasetId: "ds1", expression: "revenue*units", isAggregate: false };

describe("defaultRefFor", () => {
  it("buckets dates on the x axis and sums numeric measures", () => {
    expect(defaultRefFor("x", { kind: "column", name: "order_date" }, "line", sales, [])).toEqual({
      source: "column",
      field: "order_date",
      agg: "none",
      bucket: "month",
    });
    expect(defaultRefFor("y", { kind: "column", name: "revenue" }, "bar", sales, [])).toMatchObject({ agg: "sum" });
    expect(defaultRefFor("y", { kind: "column", name: "region" }, "bar", sales, [])).toMatchObject({ agg: "count" });
  });

  it("refuses metrics and row count as categories", () => {
    expect(defaultRefFor("x", { kind: "metric", id: "m1" }, "bar", sales, [agg])).toBeNull();
    expect(defaultRefFor("color", { kind: "rows" }, "pie", sales, [])).toBeNull();
  });

  it("scatter uses raw values and rejects aggregate metrics", () => {
    expect(defaultRefFor("x", { kind: "column", name: "units" }, "scatter", sales, [])).toMatchObject({ agg: "none" });
    expect(defaultRefFor("y", { kind: "metric", id: "m1" }, "scatter", sales, [agg])).toBeNull();
    expect(defaultRefFor("size", { kind: "metric", id: "m2" }, "scatter", sales, [row])).toMatchObject({ agg: "none" });
    expect(defaultRefFor("y", { kind: "rows" }, "scatter", sales, [])).toBeNull();
  });

  it("metrics default to sum unless already aggregate", () => {
    expect(defaultRefFor("value", { kind: "metric", id: "m1" }, "kpi", sales, [agg])).toMatchObject({ agg: "none" });
    expect(defaultRefFor("value", { kind: "metric", id: "m2" }, "kpi", sales, [row])).toMatchObject({ agg: "sum" });
  });

  it("table columns start unaggregated", () => {
    expect(defaultRefFor("columns", { kind: "column", name: "revenue" }, "table", sales, [])).toMatchObject({ agg: "none" });
    expect(defaultRefFor("columns", { kind: "rows" }, "table", sales, [])).toMatchObject({ agg: "count" });
  });
});

describe("autoZone", () => {
  it("routes dimensions and measures", () => {
    expect(autoZone("bar", { kind: "column", name: "region" }, sales, new Set())).toBe("x");
    expect(autoZone("bar", { kind: "column", name: "product" }, sales, new Set(["x"]))).toBe("color");
    expect(autoZone("bar", { kind: "column", name: "revenue" }, sales, new Set())).toBe("y");
    expect(autoZone("kpi", { kind: "column", name: "region" }, sales, new Set())).toBeNull();
    expect(autoZone("table", { kind: "column", name: "region" }, sales, new Set())).toBe("columns");
  });
});
