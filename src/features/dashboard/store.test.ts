import { beforeEach, describe, expect, it } from "vitest";
import { activeDashboard, clearHistory, findWidget, placeItem, redo, undo, useDashboard } from "./store";

const s = () => useDashboard.getState();
const dash = () => activeDashboard(s().doc);

beforeEach(() => {
  s().newProject("Test");
  clearHistory();
});

describe("dashboard store", () => {
  it("adds widgets with non-overlapping layout", () => {
    const a = s().addWidget("bar", "ds1");
    const b = s().addWidget("line", "ds1");
    const k = s().addWidget("kpi", "ds1");
    expect(dash().widgets.map((w) => w.id)).toEqual([a, b, k]);
    const [la, lb, lk] = dash().layout;
    expect(la).toMatchObject({ x: 0, y: 0, w: 6, h: 8 });
    expect(lb).toMatchObject({ x: 6, y: 0 });
    expect(lk.y).toBeGreaterThanOrEqual(8);
    expect(s().dirty).toBe(true);
  });

  it("places items in the first free slot", () => {
    expect(placeItem([], 4, 4)).toEqual({ x: 0, y: 0 });
    expect(placeItem([{ i: "a", x: 0, y: 0, w: 12, h: 2 }], 6, 2)).toEqual({ x: 0, y: 2 });
    expect(placeItem([{ i: "a", x: 0, y: 0, w: 4, h: 4 }], 4, 4)).toEqual({ x: 4, y: 0 });
  });

  it("puts, updates and removes fields per zone", () => {
    const id = s().addWidget("bar", "ds1");
    s().putField(id, "x", { source: "column", field: "region", agg: "none", id: "fx" });
    s().putField(id, "y", { source: "column", field: "revenue", agg: "sum", id: "fy" });
    s().putField(id, "y", { source: "column", field: "units", agg: "sum", id: "fu" });
    s().putField(id, "x", { source: "column", field: "product", agg: "none", id: "fx2" });
    let w = findWidget(s().doc, id)!;
    expect(w.encoding.x?.field).toBe("product");
    expect(w.encoding.y.map((r) => r.id)).toEqual(["fy", "fu"]);
    s().updateField(id, "fy", { agg: "avg" });
    s().setWidgetSort(id, [{ by: "fu", dir: "desc" }]);
    s().removeField(id, "fu");
    w = findWidget(s().doc, id)!;
    expect(w.encoding.y).toEqual([{ id: "fy", source: "column", field: "revenue", agg: "avg" }]);
    expect(w.sort).toEqual([]);
    s().putField(id, "size", { source: "column", field: "units", agg: "none" });
    expect(findWidget(s().doc, id)!.encoding.size).toBeUndefined();
  });

  it("keeps compatible fields when switching chart type", () => {
    const id = s().addWidget("bar", "ds1");
    s().putField(id, "x", { source: "column", field: "region", agg: "none", id: "fx" });
    s().putField(id, "y", { source: "column", field: "revenue", agg: "sum", id: "fy" });
    s().setChartType(id, "pie");
    let w = findWidget(s().doc, id)!;
    expect(w.encoding.value?.id).toBe("fy");
    expect(w.encoding.x).toBeUndefined();
    s().setChartType(id, "table");
    w = findWidget(s().doc, id)!;
    expect(w.encoding.columns.map((r) => r.id)).toEqual(["fy"]);
  });

  it("changing dataset resets encoding", () => {
    const id = s().addWidget("bar", "ds1");
    s().putField(id, "x", { source: "column", field: "region", agg: "none" });
    s().setDataset(id, "ds2");
    expect(findWidget(s().doc, id)!.encoding.x).toBeUndefined();
  });

  it("duplicates and deletes widgets", () => {
    const id = s().addWidget("bar", "ds1");
    s().updateConfig(id, { title: "Sales" });
    const copy = s().duplicateWidget(id)!;
    expect(copy).not.toBe(id);
    expect(findWidget(s().doc, copy)!.config.title).toBe("Sales (copy)");
    expect(dash().layout).toHaveLength(2);
    expect(s().duplicateWidget("nope")).toBeNull();
    s().removeWidget(id);
    expect(dash().widgets.map((w) => w.id)).toEqual([copy]);
    expect(dash().layout.map((l) => l.i)).toEqual([copy]);
  });

  it("setLayout ignores no-op changes and unknown items", () => {
    const id = s().addWidget("bar", "ds1");
    const before = s().doc;
    s().setLayout([...dash().layout.map((l) => ({ ...l, moved: false }))] as never);
    expect(s().doc.dashboards[0]).toBe(before.dashboards[0]);
    s().setLayout([{ i: id, x: 2, y: 3, w: 4, h: 5 }, { i: "ghost", x: 0, y: 0, w: 1, h: 1 }]);
    expect(dash().layout).toEqual([{ i: id, x: 2, y: 3, w: 4, h: 5 }]);
  });

  it("undoes and redoes document changes", () => {
    const id = s().addWidget("bar", "ds1");
    s().updateConfig(id, { title: "One" });
    s().updateConfig(id, { title: "Two" });
    undo();
    expect(findWidget(s().doc, id)!.config.title).toBe("One");
    undo();
    expect(findWidget(s().doc, id)!.config.title).toBe("");
    undo();
    expect(dash().widgets).toHaveLength(0);
    redo();
    redo();
    expect(findWidget(s().doc, id)!.config.title).toBe("One");
    expect(useDashboard.temporal.getState().futureStates).toHaveLength(1);
  });

  it("manages dashboards", () => {
    const first = dash().id;
    const second = s().addDashboard();
    expect(s().doc.activeDashboardId).toBe(second);
    s().renameDashboard(second, "Ops");
    expect(dash().name).toBe("Ops");
    s().removeDashboard(second);
    expect(s().doc.activeDashboardId).toBe(first);
    s().removeDashboard(first);
    expect(s().doc.dashboards).toHaveLength(1);
  });

  it("manages global filters", () => {
    const g = s().addGlobalFilter({ field: "region", datasetId: null, kind: "in", values: [] });
    s().updateGlobalFilter(g, { values: ["North"] } as never);
    expect(dash().globalFilters[0]).toMatchObject({ id: g, kind: "in", values: ["North"] });
    s().removeGlobalFilter(g);
    expect(dash().globalFilters).toEqual([]);
  });

  it("removing a metric removes it from widgets", () => {
    const m = s().addMetric({ name: "AOV", datasetId: "ds1", expression: "SUM(revenue)/COUNT(*)", isAggregate: true });
    const id = s().addWidget("kpi", "ds1");
    s().putField(id, "value", { source: "metric", field: m, agg: "none" });
    s().updateMetric(m, { name: "Average order" });
    expect(s().doc.metrics[0].name).toBe("Average order");
    s().removeMetric(m);
    expect(s().doc.metrics).toEqual([]);
    expect(findWidget(s().doc, id)!.encoding.value).toBeUndefined();
  });

  it("newProject resets dirty state", () => {
    s().addWidget("bar", null);
    s().newProject();
    expect(s().dirty).toBe(false);
    expect(dash().widgets).toEqual([]);
    s().renameProject("Q4");
    expect(s().doc.name).toBe("Q4");
    s().markSaved();
    expect(s().dirty).toBe(false);
  });
});
