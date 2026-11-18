import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sales } from "@/test/fixtures";
import type { DatasetChange, DatasetLoad, OpenedProject } from "@/types/project";

vi.mock("@/lib/ipc", () => ({
  isTauri: () => false,
  ipc: {
    saveProject: vi.fn(),
    openProject: vi.fn(),
    closeProject: vi.fn(),
    reloadDataset: vi.fn(),
    relocateDataset: vi.fn(),
    writeRecovery: vi.fn(),
    listRecovery: vi.fn(),
    restoreRecovery: vi.fn(),
    deleteRecovery: vi.fn(),
    confirmExit: vi.fn(),
    takePendingOpenFiles: vi.fn(),
    addRecentProject: vi.fn(),
    listDatasets: vi.fn(),
  },
}));

vi.mock("@/lib/dialogs", () => ({
  confirmDialog: vi.fn(),
  pickDataFile: vi.fn(),
  pickProjectSavePath: vi.fn(),
  pickProjectToOpen: vi.fn(),
}));

import { useUi } from "@/app/uiStore";
import { clearHistory, useDashboard } from "@/features/dashboard/store";
import { useData } from "@/features/data/store";
import * as dialogs from "@/lib/dialogs";
import { ipc } from "@/lib/ipc";
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_INTERVAL_MS,
  checkRecovery,
  confirmClose,
  describeChange,
  discardRecovery,
  keepDataset,
  newProject,
  normalizeDoc,
  openFilesFromOs,
  openLaunchFiles,
  openProject,
  projectNameFromPath,
  recoverProject,
  relocateDataset,
  reloadSource,
  requestQuit,
  saveProject,
  saveProjectAs,
  setStorageMode,
  startAutosave,
  withProjectExtension,
} from "./actions";
import { useProject } from "./store";

const m = <T extends (...args: never[]) => unknown>(f: T) => f as unknown as ReturnType<typeof vi.fn>;
const dash = () => useDashboard.getState();

const savedDoc = {
  id: "pr_saved",
  name: "Q3 Review",
  activeDashboardId: "db_1",
  dashboards: [{ id: "db_1", name: "Main", widgets: [], layout: [], globalFilters: [] }],
  metrics: [],
};

const change: DatasetChange = {
  fingerprintChanged: true,
  before: { ...sales.fingerprint, size: 100 },
  after: { ...sales.fingerprint, size: 140 },
  schema: {
    added: ["units"],
    removed: ["cost", "tax"],
    typeChanged: [{ name: "region", before: "string", after: "integer" }],
    rowCountBefore: 3,
    rowCountAfter: 1200,
  },
};

function opened(datasets: DatasetLoad[], extra: Partial<OpenedProject> = {}): OpenedProject {
  return {
    path: "/p/Q3 Review.datacanvas",
    mode: "portable",
    appVersion: "0.1.0",
    migratedFrom: null,
    project: savedDoc,
    datasets,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of Object.values(ipc)) m(f).mockResolvedValue(undefined);
  m(ipc.listDatasets).mockResolvedValue([]);
  m(ipc.listRecovery).mockResolvedValue([]);
  m(ipc.addRecentProject).mockResolvedValue([]);
  dash().newProject();
  clearHistory();
  useProject.setState({ path: null, mode: "linked", issues: [], recovery: [], busy: false });
  useData.setState({ datasets: [], selectedId: null });
  useUi.setState({ toasts: [], route: "home" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("helpers", () => {
  it("normalizes docs from disk", () => {
    const doc = normalizeDoc({ id: "pr_1", name: "", dashboards: [{ id: "d1", name: "A" }], activeDashboardId: "gone" });
    expect(doc.name).toBe("Untitled project");
    expect(doc.activeDashboardId).toBe("d1");
    expect(doc.dashboards[0]).toMatchObject({ widgets: [], layout: [], globalFilters: [] });
    expect(doc.metrics).toEqual([]);
    expect(normalizeDoc({ id: "../bad" }).id).toMatch(/^pr_/);
    expect(normalizeDoc({}).dashboards).toHaveLength(1);
    expect(() => normalizeDoc(null)).toThrow();
    expect(() => normalizeDoc([1])).toThrow();
  });

  it("handles project file names", () => {
    expect(withProjectExtension("/a/b")).toBe("/a/b.datacanvas");
    expect(withProjectExtension("/a/b.DataCanvas")).toBe("/a/b.DataCanvas");
    expect(projectNameFromPath("C:\\x\\Sales Q3.datacanvas")).toBe("Sales Q3");
  });

  it("describes source changes", () => {
    expect(describeChange(change)).toBe(
      "1 column added (units); 2 columns removed (cost, tax); 1 type change (region); rows 3 → 1,200",
    );
    expect(describeChange({ ...change, schema: null })).toBe("file size 100 → 140 bytes");
    expect(describeChange({ ...change, fingerprintChanged: false, schema: null })).toBe("no changes");
  });
});

describe("save", () => {
  it("asks for a path the first time, then saves in place", async () => {
    m(dialogs.pickProjectSavePath).mockResolvedValue("/p/Sales");
    dash().addWidget("bar", "ds1");
    setStorageMode("portable");
    expect(await saveProject()).toBe(true);
    const doc = dash().doc;
    expect(ipc.saveProject).toHaveBeenCalledWith("/p/Sales.datacanvas", "portable", doc);
    expect(doc.name).toBe("Sales");
    expect(dash().dirty).toBe(false);
    expect(useProject.getState().path).toBe("/p/Sales.datacanvas");
    expect(ipc.deleteRecovery).toHaveBeenCalledWith(doc.id);
    expect(ipc.addRecentProject).toHaveBeenCalledWith("/p/Sales.datacanvas", "Sales");

    dash().addWidget("line", "ds1");
    await saveProject();
    expect(dialogs.pickProjectSavePath).toHaveBeenCalledTimes(1);
    expect(ipc.saveProject).toHaveBeenLastCalledWith("/p/Sales.datacanvas", "portable", dash().doc);
  });

  it("Save As keeps a custom name and cancelling does nothing", async () => {
    dash().renameProject("Board pack");
    m(dialogs.pickProjectSavePath).mockResolvedValue(null);
    expect(await saveProjectAs()).toBe(false);
    expect(ipc.saveProject).not.toHaveBeenCalled();
    m(dialogs.pickProjectSavePath).mockResolvedValue("/p/other.datacanvas");
    await saveProjectAs();
    expect(dash().doc.name).toBe("Board pack");
  });

  it("stays dirty when saving fails", async () => {
    useProject.setState({ path: "/p/a.datacanvas" });
    dash().addWidget("bar", "ds1");
    m(ipc.saveProject).mockRejectedValue({ kind: "io", message: "disk full" });
    expect(await saveProject()).toBe(false);
    expect(dash().dirty).toBe(true);
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ tone: "error", description: "disk full" });
  });

  it("keeps edits made during the save dirty", async () => {
    useProject.setState({ path: "/p/a.datacanvas" });
    m(ipc.saveProject).mockImplementation(async () => {
      dash().addWidget("kpi", "ds1");
    });
    await saveProject();
    expect(dash().dirty).toBe(true);
  });
});

describe("open", () => {
  it("does nothing when the user keeps unsaved changes", async () => {
    dash().addWidget("bar", "ds1");
    m(dialogs.confirmDialog).mockResolvedValue(false);
    await openProject("/p/x.datacanvas");
    expect(ipc.openProject).not.toHaveBeenCalled();
  });

  it("loads the doc, datasets and issues", async () => {
    const missing: DatasetLoad = { id: "ds2", name: "Targets", status: "missing", searched: ["/p/t.csv"] };
    const changed: DatasetLoad = { id: "ds3", name: "Costs", status: "changed", change, loadedFrom: "source", meta: sales };
    m(ipc.openProject).mockResolvedValue(
      opened([{ id: sales.id, name: sales.name, status: "ok", meta: sales }, missing, changed], { migratedFrom: 0 }),
    );
    m(ipc.listDatasets).mockResolvedValue([sales]);
    await openProject("/p/Q3 Review.datacanvas");

    expect(dash().doc).toEqual(savedDoc);
    expect(dash().dirty).toBe(false);
    expect(useDashboard.temporal.getState().pastStates).toHaveLength(0);
    expect(useProject.getState()).toMatchObject({ path: "/p/Q3 Review.datacanvas", mode: "portable" });
    expect(useProject.getState().issues.map((i) => i.id)).toEqual(["ds2", "ds3"]);
    expect(useData.getState().datasets).toEqual([sales]);
    expect(ipc.addRecentProject).toHaveBeenCalledWith("/p/Q3 Review.datacanvas", "Q3 Review");
    expect(useUi.getState().route).toBe("dashboard");
    expect(useUi.getState().toasts.at(-1)?.description).toContain("Upgraded from file format 0");
  });

  it("reports open errors without touching the current project", async () => {
    dash().renameProject("Current");
    dash().markSaved();
    m(ipc.openProject).mockRejectedValue({ kind: "unsupportedFile", message: "saved by a newer DataCanvas" });
    m(dialogs.pickProjectToOpen).mockResolvedValue("/p/new.datacanvas");
    await openProject();
    expect(dash().doc.name).toBe("Current");
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ tone: "error" });
  });

  it("new project forgets the file and the old snapshot", async () => {
    useProject.setState({ path: "/p/a.datacanvas", issues: [{ id: "x", name: "x", status: "failed", message: "" }] });
    const old = dash().doc.id;
    await newProject();
    expect(useProject.getState().path).toBeNull();
    expect(useProject.getState().issues).toEqual([]);
    expect(ipc.closeProject).toHaveBeenCalled();
    expect(ipc.deleteRecovery).toHaveBeenCalledWith(old);
  });
});

describe("datasets", () => {
  beforeEach(() => {
    useData.setState({ datasets: [sales] });
    useProject.setState({
      issues: [
        { id: sales.id, name: sales.name, status: "missing", searched: [] },
        { id: "ds3", name: "Costs", status: "changed", change },
      ],
    });
  });

  it("relocates a missing dataset", async () => {
    const moved = { ...sales, source: { ...sales.source, path: "/new/sales.csv" } };
    m(dialogs.pickDataFile).mockResolvedValue("/new/sales.csv");
    m(ipc.relocateDataset).mockResolvedValue({ id: sales.id, name: sales.name, status: "ok", meta: moved });
    expect(await relocateDataset(sales.id)).toBe(true);
    expect(ipc.relocateDataset).toHaveBeenCalledWith(sales.id, "/new/sales.csv");
    expect(useData.getState().datasets[0].source.path).toBe("/new/sales.csv");
    expect(useProject.getState().issues.map((i) => i.id)).toEqual(["ds3"]);
    expect(dash().dirty).toBe(true);
  });

  it("reload source reports the diff", async () => {
    m(ipc.reloadDataset).mockResolvedValue({ id: "ds3", name: "Costs", status: "changed", change, meta: sales });
    expect(await reloadSource("ds3")).toBe(true);
    expect(useUi.getState().toasts.at(-1)?.description).toContain("1 column added (units)");
    expect(useProject.getState().issues.map((i) => i.id)).toEqual([sales.id]);
  });

  it("reload source offers to relocate a missing file", async () => {
    m(ipc.reloadDataset).mockRejectedValue({ kind: "fileNotFound", message: "File not found: /a.csv" });
    m(dialogs.confirmDialog).mockResolvedValue(true);
    m(dialogs.pickDataFile).mockResolvedValue("/b.csv");
    m(ipc.relocateDataset).mockResolvedValue({ id: sales.id, name: sales.name, status: "ok", meta: sales });
    expect(await reloadSource(sales.id)).toBe(true);
    expect(ipc.relocateDataset).toHaveBeenCalledWith(sales.id, "/b.csv");
  });

  it("keep dismisses a changed dataset without marking dirty", () => {
    keepDataset("ds3");
    expect(useProject.getState().issues.map((i) => i.id)).toEqual([sales.id]);
    expect(dash().dirty).toBe(false);
  });
});

describe("autosave and recovery", () => {
  it("snapshots shortly after becoming dirty and every 30 s while dirty", async () => {
    vi.useFakeTimers();
    const stop = startAutosave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS);
    expect(ipc.writeRecovery).not.toHaveBeenCalled();

    dash().addWidget("bar", "ds1");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(ipc.writeRecovery).toHaveBeenCalledTimes(1);
    expect(ipc.writeRecovery).toHaveBeenCalledWith(dash().doc.id, "linked", dash().doc);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS);
    expect(ipc.writeRecovery).toHaveBeenCalledTimes(2);

    dash().markSaved();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS * 2);
    expect(ipc.writeRecovery).toHaveBeenCalledTimes(2);
    stop();
    dash().markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS);
    expect(ipc.writeRecovery).toHaveBeenCalledTimes(2);
  });

  it("offers snapshots at launch and restores one as unsaved work", async () => {
    const summary = { projectId: "pr_saved", projectPath: null, name: "Q3 Review", savedAt: "2026-11-18T00:00:00Z", datasetCount: 1 };
    const other = { ...summary, projectId: "pr_other" };
    m(ipc.listRecovery).mockResolvedValue([summary, other]);
    await checkRecovery();
    expect(useProject.getState().recovery).toHaveLength(2);

    m(ipc.restoreRecovery).mockResolvedValue(opened([], { path: null, mode: "linked" }));
    await recoverProject("pr_saved");
    expect(dash().doc.id).toBe("pr_saved");
    expect(dash().dirty).toBe(true);
    expect(useProject.getState().path).toBeNull();
    expect(useProject.getState().recovery.map((r) => r.projectId)).toEqual(["pr_other"]);

    await discardRecovery("pr_other");
    expect(ipc.deleteRecovery).toHaveBeenCalledWith("pr_other");
    expect(useProject.getState().recovery).toEqual([]);
  });

  it("confirms close when dirty and removes the snapshot on a clean close", async () => {
    expect(await confirmClose()).toBe(true);
    dash().addWidget("bar", "ds1");
    m(dialogs.confirmDialog).mockResolvedValue(false);
    expect(await confirmClose()).toBe(false);
    m(dialogs.confirmDialog).mockResolvedValue(true);
    expect(await confirmClose()).toBe(true);
    expect(ipc.deleteRecovery).toHaveBeenCalledWith(dash().doc.id);
  });
});

describe("quit", () => {
  it("quits straight away when there is nothing to save", async () => {
    expect(await requestQuit()).toBe(true);
    expect(dialogs.confirmDialog).not.toHaveBeenCalled();
    expect(ipc.confirmExit).toHaveBeenCalledTimes(1);
  });

  it("keeps the app and the snapshot when the user cancels", async () => {
    dash().addWidget("bar", "ds1");
    m(dialogs.confirmDialog).mockResolvedValue(false);
    expect(await requestQuit()).toBe(false);
    expect(ipc.confirmExit).not.toHaveBeenCalled();
    expect(ipc.deleteRecovery).not.toHaveBeenCalled();
  });

  it("shares one prompt between repeated Cmd+Q presses", async () => {
    dash().addWidget("bar", "ds1");
    let answer!: (ok: boolean) => void;
    m(dialogs.confirmDialog).mockReturnValue(new Promise<boolean>((r) => (answer = r)));
    const first = requestQuit();
    const second = requestQuit();
    answer(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(dialogs.confirmDialog).toHaveBeenCalledTimes(1);
    expect(ipc.deleteRecovery).toHaveBeenCalledWith(dash().doc.id);
    expect(ipc.confirmExit).toHaveBeenCalledTimes(1);
  });
});

describe("file association", () => {
  it("opens the first project file handed over by the OS", async () => {
    m(ipc.openProject).mockResolvedValue(opened([]));
    m(ipc.takePendingOpenFiles).mockResolvedValue(["/p/data.csv", "/p/Q3 Review.DataCanvas"]);
    await openLaunchFiles();
    expect(ipc.openProject).toHaveBeenCalledWith("/p/Q3 Review.DataCanvas");
  });

  it("ignores non-project files and asks before discarding changes", async () => {
    await openFilesFromOs(["/p/data.csv"]);
    expect(ipc.openProject).not.toHaveBeenCalled();
    dash().addWidget("bar", "ds1");
    m(dialogs.confirmDialog).mockResolvedValue(false);
    await openFilesFromOs(["/p/x.datacanvas"]);
    expect(ipc.openProject).not.toHaveBeenCalled();
  });
});
