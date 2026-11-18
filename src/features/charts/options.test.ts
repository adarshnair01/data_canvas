import { describe, expect, it } from "vitest";
import { col, widget } from "@/test/fixtures";
import { PALETTES } from "@/types/chart";
import type { QueryResult } from "@/types/query";
import {
  cartesianOption,
  chartOption,
  formatCategory,
  formatNumber,
  kpiModel,
  pieOption,
  scatterOption,
  tableModel,
} from "./options";

const res = (ids: [string, "dimension" | "measure"][], rows: QueryResult["rows"]): QueryResult => ({
  columns: ids.map(([id, role]) => ({ id, role })),
  rows,
  truncated: false,
  elapsedMs: 1,
});

type AnyObj = Record<string, any>;

describe("formatting", () => {
  it("formats date buckets and nulls", () => {
    expect(formatCategory("2024-04-01", "month")).toBe("Apr 2024");
    expect(formatCategory("2024-04-01", "quarter")).toBe("2024 Q2");
    expect(formatCategory("2024-04-01", "year")).toBe("2024");
    expect(formatCategory("2024-04-03", "day")).toBe("2024-04-03");
    expect(formatCategory(null)).toBe("(empty)");
    expect(formatCategory(true)).toBe("true");
    expect(formatNumber(null)).toBe("–");
    expect(formatNumber(1234.5, 1)).toMatch(/1.?234.5/);
  });
});

describe("cartesianOption", () => {
  it("maps one series per measure", () => {
    const w = widget("bar", { x: col("region", "x"), y: [col("revenue", "y", { agg: "sum" }), col("units", "u", { agg: "sum" })] });
    w.config.title = "Revenue";
    const o = cartesianOption(
      w,
      res([["x", "dimension"], ["y", "measure"], ["u", "measure"]], [["North", 10, 1], ["South", 20, 2]]),
    ) as AnyObj;
    expect(o.xAxis.data).toEqual(["North", "South"]);
    expect(o.series).toHaveLength(2);
    expect(o.series[0]).toMatchObject({ type: "bar", name: "Sum of revenue", data: [10, 20] });
    expect(o.series[1].data).toEqual([1, 2]);
    expect(o.title).toMatchObject({ show: true, text: "Revenue" });
    expect(o.color).toEqual(PALETTES.default);
  });

  it("pivots the color dimension into series with gaps as null", () => {
    const w = widget("line", {
      x: col("order_date", "x", { bucket: "month" }),
      y: [col("revenue", "y", { agg: "sum" })],
      color: col("region", "c"),
    });
    const o = cartesianOption(
      w,
      res(
        [["x", "dimension"], ["c", "dimension"], ["y", "measure"]],
        [
          ["2024-01-01", "North", 5],
          ["2024-01-01", "South", 7],
          ["2024-02-01", "North", 9],
        ],
      ),
    ) as AnyObj;
    expect(o.xAxis.data).toEqual(["Jan 2024", "Feb 2024"]);
    expect(o.series.map((s: AnyObj) => s.name)).toEqual(["North", "South"]);
    expect(o.series[1].data).toEqual([7, null]);
    expect(o.series[0].type).toBe("line");
    expect(o.series[0].areaStyle).toBeUndefined();
  });

  it("supports area, stacking, horizontal bars and palettes", () => {
    const area = widget("area", { x: col("region", "x"), y: [col("revenue", "y", { agg: "sum" })] });
    area.config.stacked = true;
    area.config.palette = "sunset";
    const a = cartesianOption(area, res([["x", "dimension"], ["y", "measure"]], [["N", 1]])) as AnyObj;
    expect(a.series[0].areaStyle).toBeDefined();
    expect(a.series[0].stack).toBe("total");
    expect(a.color).toEqual(PALETTES.sunset);

    const bar = widget("bar", { x: col("region", "x"), y: [col("revenue", "y", { agg: "sum" })] });
    bar.config.horizontal = true;
    bar.config.legend = { show: false, position: "bottom" };
    const b = cartesianOption(bar, res([["x", "dimension"], ["y", "measure"]], [["N", 1]])) as AnyObj;
    expect(b.yAxis.type).toBe("category");
    expect(b.xAxis.type).toBe("value");
    expect(b.legend.show).toBe(false);
  });

  it("coerces numeric strings and non-numbers", () => {
    const w = widget("bar", { x: col("region", "x"), y: [col("revenue", "y", { agg: "sum" })] });
    const o = cartesianOption(w, res([["x", "dimension"], ["y", "measure"]], [["A", "3.5"], ["B", "n/a"], [null, 2]])) as AnyObj;
    expect(o.series[0].data).toEqual([3.5, null, 2]);
    expect(o.xAxis.data).toEqual(["A", "B", "(empty)"]);
  });
});

describe("pie, scatter, kpi, table", () => {
  it("pie maps name/value pairs and donut radius", () => {
    const w = widget("pie", { color: col("product", "s"), value: col("revenue", "v", { agg: "sum" }) });
    w.config.donut = true;
    const o = pieOption(w, res([["s", "dimension"], ["v", "measure"]], [["A", 3], ["B", 1]])) as AnyObj;
    expect(o.series[0].data).toEqual([{ name: "A", value: 3 }, { name: "B", value: 1 }]);
    expect(o.series[0].radius).toEqual(["45%", "70%"]);
  });

  it("scatter groups by color and scales symbol sizes", () => {
    const w = widget("scatter", {
      x: col("units", "x"),
      y: [col("revenue", "y")],
      size: col("units", "s"),
      color: col("region", "c"),
    });
    const o = scatterOption(
      w,
      res(
        [["c", "dimension"], ["x", "measure"], ["y", "measure"], ["s", "measure"]],
        [["N", 1, 10, 5], ["S", 2, 20, 10], ["N", 3, 30, 0]],
      ),
    ) as AnyObj;
    expect(o.series.map((s: AnyObj) => s.name)).toEqual(["N", "S"]);
    expect(o.series[0].data[0].value).toEqual([1, 10, 5]);
    expect(o.series[1].data[0].symbolSize).toBe(36);
    expect(o.series[0].data[1].symbolSize).toBe(6);
    expect(o.xAxis.name).toBe("units");
  });

  it("kpi formats with prefix/suffix/decimals", () => {
    const w = widget("kpi", { value: col("revenue", "v", { agg: "sum" }) });
    w.config.kpi = { prefix: "$", suffix: "k", decimals: 1 };
    const k = kpiModel(w, res([["v", "measure"]], [[1234.56]]));
    expect(k.value).toBe(1234.56);
    expect(k.text).toMatch(/^\$1.?234\.6k$/);
    expect(k.label).toBe("Sum of revenue");
    expect(kpiModel(w, res([["v", "measure"]], [])).text).toBe("–");
  });

  it("table builds headers from field labels", () => {
    const w = widget("table", { columns: [col("region", "a"), col("revenue", "b", { agg: "sum" })] });
    const t = tableModel(w, res([["a", "dimension"], ["b", "measure"]], [["N", 1.5], [null, 2]]));
    expect(t.headers).toEqual([
      { id: "a", label: "region", numeric: false },
      { id: "b", label: "Sum of revenue", numeric: true },
    ]);
    expect(t.rows[1][0]).toBe("(empty)");
  });

  it("chartOption returns null for non-echarts types", () => {
    expect(chartOption(widget("kpi"), res([], []))).toBeNull();
    expect(chartOption(widget("table"), res([], []))).toBeNull();
  });
});
