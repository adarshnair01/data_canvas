import { describe, expect, it } from "vitest";
import { col, sales, widget } from "@/test/fixtures";
import type { CalculatedMetric } from "@/types/metrics";
import type { GlobalFilter } from "@/types/project";
import { applicableGlobalFilters, buildQuerySpec, refLabel } from "./specBuilder";

const margin: CalculatedMetric = {
  id: "m_margin",
  name: "Avg order",
  datasetId: sales.id,
  expression: "SUM(revenue) / COUNT(*)",
  isAggregate: true,
};
const lineTotal: CalculatedMetric = {
  id: "m_line",
  name: "Line total",
  datasetId: sales.id,
  expression: "revenue * units",
  isAggregate: false,
};

function ok(r: ReturnType<typeof buildQuerySpec>) {
  if (!r.ok) throw new Error(r.reason);
  return r.spec;
}

describe("buildQuerySpec", () => {
  it("requires a dataset and complete encoding", () => {
    expect(buildQuerySpec(widget("bar"), undefined, [], [])).toEqual({ ok: false, reason: "Choose a dataset" });
    expect(buildQuerySpec(widget("bar"), sales, [], [])).toMatchObject({ ok: false });
    expect(buildQuerySpec(widget("bar", { x: col("region", "x") }), sales, [], [])).toMatchObject({
      ok: false,
      reason: "Add a measure to the Y axis",
    });
  });

  it("bar: groups by x, defaults numeric agg to sum and sorts by measure", () => {
    const spec = ok(
      buildQuerySpec(widget("bar", { x: col("region", "x"), y: [col("revenue", "y")] }), sales, [], []),
    );
    expect(spec).toEqual({
      datasetId: "ds1",
      mode: "aggregate",
      dimensions: [{ id: "x", field: "region" }],
      measures: [{ id: "y", source: { type: "column", column: "revenue" }, agg: "sum" }],
      filters: [],
      sort: [{ by: "y", dir: "desc" }],
    });
  });

  it("line with date bucket and color pivots to one measure, sorted by x", () => {
    const spec = ok(
      buildQuerySpec(
        widget("line", {
          x: col("order_date", "x", { bucket: "month" }),
          y: [col("revenue", "y", { agg: "avg" }), col("units", "y2", { agg: "sum" })],
          color: col("region", "c"),
        }),
        sales,
        [],
        [],
      ),
    );
    expect(spec.dimensions).toEqual([
      { id: "x", field: "order_date", bucket: "month" },
      { id: "c", field: "region" },
    ]);
    expect(spec.measures).toHaveLength(1);
    expect(spec.measures[0].agg).toBe("avg");
    expect(spec.sort).toEqual([{ by: "x", dir: "asc" }]);
  });

  it("drops buckets on non-date columns and falls back to count for text measures", () => {
    const spec = ok(
      buildQuerySpec(
        widget("area", { x: col("region", "x", { bucket: "year" }), y: [col("product", "y", { agg: "sum" })] }),
        sales,
        [],
        [],
      ),
    );
    expect(spec.dimensions[0]).toEqual({ id: "x", field: "region" });
    expect(spec.measures[0].agg).toBe("count");
  });

  it("pie uses slices + value sorted descending", () => {
    const spec = ok(
      buildQuerySpec(
        widget("pie", { color: col("product", "s"), value: { id: "v", source: "rows", field: "", agg: "count" } }),
        sales,
        [],
        [],
      ),
    );
    expect(spec.measures).toEqual([{ id: "v", source: { type: "rows" }, agg: "count" }]);
    expect(spec.sort).toEqual([{ by: "v", dir: "desc" }]);
  });

  it("scatter queries raw rows and rejects aggregate metrics", () => {
    const spec = ok(
      buildQuerySpec(
        widget("scatter", {
          x: col("units", "x", { agg: "sum" }),
          y: [col("revenue", "y")],
          size: { id: "s", source: "metric", field: lineTotal.id, agg: "sum" },
          color: col("region", "c"),
        }),
        sales,
        [lineTotal],
        [],
      ),
    );
    expect(spec.mode).toBe("raw");
    expect(spec.measures.map((m) => m.agg)).toEqual(["none", "none", "none"]);
    expect(spec.measures[2].source).toEqual({ type: "expression", expression: "revenue * units" });
    const bad = buildQuerySpec(
      widget("scatter", { x: col("units", "x"), y: [{ id: "y", source: "metric", field: margin.id, agg: "none" }] }),
      sales,
      [margin],
      [],
    );
    expect(bad.ok).toBe(false);
  });

  it("kpi with aggregate metric keeps agg none and limit 1", () => {
    const spec = ok(
      buildQuerySpec(widget("kpi", { value: { id: "v", source: "metric", field: margin.id, agg: "sum" } }), sales, [margin], []),
    );
    expect(spec.measures).toEqual([
      { id: "v", source: { type: "expression", expression: margin.expression }, agg: "none" },
    ]);
    expect(spec.dimensions).toEqual([]);
    expect(spec.limit).toBe(1);
  });

  it("table switches between raw and aggregate mode", () => {
    const raw = ok(
      buildQuerySpec(widget("table", { columns: [col("region", "a"), col("revenue", "b")] }), sales, [], []),
    );
    expect(raw.mode).toBe("raw");
    expect(raw.dimensions.map((d) => d.id)).toEqual(["a", "b"]);
    const agg = ok(
      buildQuerySpec(
        widget("table", { columns: [col("region", "a"), col("revenue", "b", { agg: "max" })] }, { sort: [{ by: "b", dir: "desc" }, { by: "gone", dir: "asc" }] }),
        sales,
        [],
        [],
      ),
    );
    expect(agg.mode).toBe("aggregate");
    expect(agg.dimensions).toEqual([{ id: "a", field: "region" }]);
    expect(agg.measures).toEqual([{ id: "b", source: { type: "column", column: "revenue" }, agg: "max" }]);
    expect(agg.sort).toEqual([{ by: "b", dir: "desc" }]);
  });

  it("rejects metrics from other datasets and metrics as categories", () => {
    const other = { ...margin, datasetId: "other" };
    expect(
      buildQuerySpec(widget("kpi", { value: { id: "v", source: "metric", field: other.id, agg: "none" } }), sales, [other], []).ok,
    ).toBe(false);
    expect(
      buildQuerySpec(widget("bar", { x: { id: "x", source: "metric", field: margin.id, agg: "none" }, y: [col("revenue", "y")] }), sales, [margin], []).ok,
    ).toBe(false);
  });

  it("merges widget and applicable global filters", () => {
    const globals: GlobalFilter[] = [
      { id: "g1", field: "region", datasetId: null, kind: "in", values: ["North"] },
      { id: "g2", field: "missing_col", datasetId: null, kind: "in", values: ["x"] },
      { id: "g3", field: "revenue", datasetId: "other_ds", kind: "range", min: 1 },
      { id: "g4", field: "order_date", datasetId: sales.id, kind: "dateRange", from: "2024-01-01", to: "" },
      { id: "g5", field: "units", datasetId: null, kind: "range", min: null, max: null },
      { id: "g6", field: "region", datasetId: null, kind: "range", min: 1 },
    ];
    const spec = ok(
      buildQuerySpec(
        widget(
          "bar",
          { x: col("region", "x"), y: [col("revenue", "y")] },
          { filters: [{ kind: "contains", field: "product", text: "Gad" }] },
        ),
        sales,
        [],
        globals,
      ),
    );
    expect(spec.filters).toEqual([
      { kind: "contains", field: "product", text: "Gad" },
      { kind: "in", field: "region", values: ["North"] },
      { kind: "dateRange", field: "order_date", from: "2024-01-01", to: null },
    ]);
    expect(applicableGlobalFilters(sales, [])).toEqual([]);
  });
});

describe("refLabel", () => {
  it("describes fields", () => {
    expect(refLabel(col("revenue", "a", { agg: "sum" }))).toBe("Sum of revenue");
    expect(refLabel(col("order_date", "a", { bucket: "month" }))).toBe("order_date (month)");
    expect(refLabel({ id: "a", source: "rows", field: "", agg: "count" })).toBe("Row count");
    expect(refLabel({ id: "a", source: "metric", field: margin.id, agg: "none" }, [margin])).toBe("Avg order");
    expect(refLabel(col("revenue", "a", { label: "Custom" }))).toBe("Custom");
  });
});
