/**
 * Project lifecycle entry points used by the menu, shortcuts and Home screen:
 * new/open/save, dataset relinking after open, Reload source, and autosave/recovery.
 */

import { toast, useUi } from "@/app/uiStore";
import { clearHistory, newDashboard, useDashboard } from "@/features/dashboard/store";
import { useData } from "@/features/data/store";
import { confirmDialog, pickDataFile, pickProjectSavePath, pickProjectToOpen } from "@/lib/dialogs";
import { ipc } from "@/lib/ipc";
import { fileName, PROJECT_EXTENSION } from "@/lib/platform";
import { capabilities } from "@/lib/target";
import { newId } from "@/lib/utils";
import { errorMessage, isAppError } from "@/types/errors";
import type { DatasetChange, DatasetLoad, OpenedProject, ProjectDoc, ProjectStorageMode } from "@/types/project";
import { useProject } from "./store";

export const AUTOSAVE_INTERVAL_MS = 30_000;
/** Delay before the first snapshot after the project becomes dirty, to batch rapid edits. */
export const AUTOSAVE_DEBOUNCE_MS = 1_000;
const DEFAULT_NAME = "Untitled project";

async function confirmDiscard(message: string): Promise<boolean> {
  return !useDashboard.getState().dirty || confirmDialog(message);
}

/** Validate a `ProjectDoc` from disk and fill in fields older files may lack. */
export function normalizeDoc(raw: unknown): ProjectDoc {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("The project file does not contain a valid project.");
  }
  const r = raw as Partial<ProjectDoc>;
  const dashboards =
    Array.isArray(r.dashboards) && r.dashboards.length
      ? r.dashboards.map((d) => ({
          ...d,
          widgets: Array.isArray(d.widgets) ? d.widgets : [],
          layout: Array.isArray(d.layout) ? d.layout : [],
          globalFilters: Array.isArray(d.globalFilters) ? d.globalFilters : [],
        }))
      : [newDashboard()];
  const activeDashboardId = dashboards.some((d) => d.id === r.activeDashboardId)
    ? r.activeDashboardId!
    : dashboards[0].id;
  return {
    id: typeof r.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(r.id) ? r.id : newId("pr"),
    name: typeof r.name === "string" && r.name.trim() ? r.name : DEFAULT_NAME,
    dashboards,
    activeDashboardId,
    metrics: Array.isArray(r.metrics) ? r.metrics : [],
  };
}

export function withProjectExtension(path: string): string {
  return path.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`) ? path : `${path}.${PROJECT_EXTENSION}`;
}

export function projectNameFromPath(path: string): string {
  return fileName(path).replace(new RegExp(`\\.${PROJECT_EXTENSION}$`, "i"), "") || DEFAULT_NAME;
}

/** One-line summary of what changed in a dataset's source, for toasts and the issues dialog. */
export function describeChange(change: DatasetChange): string {
  const parts: string[] = [];
  const s = change.schema;
  const list = (cols: string[]) => (cols.length > 3 ? `${cols.slice(0, 3).join(", ")}, …` : cols.join(", "));
  if (s?.added.length) parts.push(`${s.added.length} column${s.added.length > 1 ? "s" : ""} added (${list(s.added)})`);
  if (s?.removed.length)
    parts.push(`${s.removed.length} column${s.removed.length > 1 ? "s" : ""} removed (${list(s.removed)})`);
  if (s?.typeChanged.length)
    parts.push(`${s.typeChanged.length} type change${s.typeChanged.length > 1 ? "s" : ""} (${list(s.typeChanged.map((t) => t.name))})`);
  if (s && s.rowCountBefore !== s.rowCountAfter)
    parts.push(`rows ${s.rowCountBefore.toLocaleString()} → ${s.rowCountAfter.toLocaleString()}`);
  if (!parts.length && change.fingerprintChanged) {
    parts.push(
      change.after.size !== change.before.size
        ? `file size ${change.before.size.toLocaleString()} → ${change.after.size.toLocaleString()} bytes`
        : "file contents changed",
    );
  }
  return parts.length ? parts.join("; ") : "no changes";
}

function applyOpened(opened: OpenedProject): ProjectDoc {
  const doc = normalizeDoc(opened.project);
  useDashboard.getState().loadDoc(doc);
  clearHistory();
  const project = useProject.getState();
  project.setPath(opened.path);
  project.setMode(capabilities.linkedStorage ? opened.mode : "portable");
  project.setIssues(opened.datasets.filter((d) => d.status !== "ok"));
  useUi.getState().selectWidget(null);
  useUi.getState().navigate("dashboard");
  return doc;
}

async function refreshDatasets() {
  try {
    await useData.getState().refresh();
  } catch (e) {
    toast({ tone: "error", title: "Could not load datasets", description: errorMessage(e) });
  }
}

function forgetSnapshot(projectId: string) {
  ipc.deleteRecovery(projectId).catch(() => {});
}

export async function newProject() {
  if (!(await confirmDiscard("Discard unsaved changes and start a new project?"))) return;
  const previous = useDashboard.getState().doc.id;
  useDashboard.getState().newProject();
  clearHistory();
  forgetSnapshot(previous);
  await ipc.closeProject().catch(() => {});
  const project = useProject.getState();
  project.setPath(null);
  project.setIssues([]);
  useUi.getState().selectWidget(null);
  useUi.getState().navigate("dashboard");
}

export async function openProject(path?: string) {
  if (!(await confirmDiscard("Discard unsaved changes and open another project?"))) return;
  const target = path ?? (await pickProjectToOpen());
  if (!target) return;
  const previous = useDashboard.getState().doc.id;
  useProject.getState().setBusy(true);
  try {
    const opened = await ipc.openProject(target);
    const doc = applyOpened(opened);
    if (previous !== doc.id) forgetSnapshot(previous);
    await refreshDatasets();
    await ipc.addRecentProject(target, doc.name).catch(() => {});
    const problems = opened.datasets.filter((d) => d.status !== "ok").length;
    toast({
      tone: "success",
      title: `Opened ${doc.name}`,
      description: [
        opened.migratedFrom != null ? `Upgraded from file format ${opened.migratedFrom}.` : "",
        problems ? `${problems} dataset${problems > 1 ? "s need" : " needs"} attention.` : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    });
  } catch (e) {
    toast({ tone: "error", title: "Could not open project", description: errorMessage(e) });
  } finally {
    useProject.getState().setBusy(false);
  }
}

async function saveTo(path: string): Promise<boolean> {
  const { mode } = useProject.getState();
  const doc = useDashboard.getState().doc;
  useProject.getState().setBusy(true);
  try {
    await ipc.saveProject(path, mode, doc);
    // Edits made while the save was in flight stay dirty.
    if (useDashboard.getState().doc === doc) useDashboard.getState().markSaved();
    useProject.getState().setPath(path);
    forgetSnapshot(doc.id);
    await ipc.addRecentProject(path, doc.name).catch(() => {});
    toast({ tone: "success", title: "Project saved", description: `${fileName(path)} (${mode})` });
    return true;
  } catch (e) {
    toast({ tone: "error", title: "Could not save project", description: errorMessage(e) });
    return false;
  } finally {
    useProject.getState().setBusy(false);
  }
}

export async function saveProject(): Promise<boolean> {
  const { path } = useProject.getState();
  return path ? saveTo(path) : saveProjectAs();
}

export async function saveProjectAs(): Promise<boolean> {
  const picked = await pickProjectSavePath(useDashboard.getState().doc.name);
  if (!picked) return false;
  const path = withProjectExtension(picked);
  if (useDashboard.getState().doc.name === DEFAULT_NAME) {
    useDashboard.getState().renameProject(projectNameFromPath(path));
  }
  return saveTo(path);
}

export function setStorageMode(mode: ProjectStorageMode) {
  if (useProject.getState().mode === mode) return;
  useProject.getState().setMode(mode);
  useDashboard.getState().markDirty();
}

function applyDatasetLoad(load: DatasetLoad, title: string) {
  if (load.meta) useData.getState().upsert(load.meta);
  useProject.getState().resolveIssue(load.id);
  useDashboard.getState().markDirty();
  toast({
    tone: "success",
    title,
    description: load.status === "changed" ? `${load.name}: ${describeChange(load.change)}` : load.name,
  });
}

/** Point a dataset at another file (missing source, or a replacement chosen by the user). */
export async function relocateDataset(id: string): Promise<boolean> {
  const path = await pickDataFile();
  if (!path) return false;
  try {
    applyDatasetLoad(await ipc.relocateDataset(id, path), "Dataset relinked");
    return true;
  } catch (e) {
    toast({ tone: "error", title: "Could not relink dataset", description: errorMessage(e) });
    return false;
  }
}

/** Reload source: re-read a linked dataset from disk. Offers Relocate when the file is gone. */
export async function reloadSource(id: string): Promise<boolean> {
  try {
    applyDatasetLoad(await ipc.reloadDataset(id), "Source reloaded");
    return true;
  } catch (e) {
    if (isAppError(e) && e.kind === "fileNotFound") {
      if (await confirmDialog("The source file was not found. Locate it?")) return relocateDataset(id);
      return false;
    }
    toast({ tone: "error", title: "Could not reload source", description: errorMessage(e) });
    return false;
  }
}

/** "Keep" in the changed-source dialog: leave the project's recorded schema and fingerprint. */
export function keepDataset(id: string) {
  useProject.getState().resolveIssue(id);
}

// ---------------------------------------------------------------------------------------------
// Autosave and recovery

export async function writeSnapshot(): Promise<void> {
  const { doc, dirty } = useDashboard.getState();
  if (!dirty) return;
  await ipc.writeRecovery(doc.id, useProject.getState().mode, doc);
}

/** Snapshot every 30 s while dirty and shortly after the project becomes dirty. */
export function startAutosave(): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    pending = null;
    writeSnapshot().catch((e) => console.warn("autosave failed", e));
  };
  const interval = setInterval(write, AUTOSAVE_INTERVAL_MS);
  const unsubscribe = useDashboard.subscribe((s, prev) => {
    if (s.dirty && !prev.dirty && !pending) pending = setTimeout(write, AUTOSAVE_DEBOUNCE_MS);
  });
  return () => {
    clearInterval(interval);
    if (pending) clearTimeout(pending);
    unsubscribe();
  };
}

/** At launch: any snapshot on disk means the previous session did not exit cleanly. */
export async function checkRecovery() {
  try {
    useProject.getState().setRecovery(await ipc.listRecovery());
  } catch (e) {
    console.warn("could not list recovery snapshots", e);
  }
}

export async function recoverProject(projectId: string) {
  useProject.getState().setBusy(true);
  try {
    const opened = await ipc.restoreRecovery(projectId);
    const doc = applyOpened(opened);
    useDashboard.getState().markDirty();
    await refreshDatasets();
    toast({ tone: "success", title: `Recovered ${doc.name}`, description: "Save the project to keep these changes." });
  } catch (e) {
    toast({ tone: "error", title: "Could not recover project", description: errorMessage(e) });
  } finally {
    const p = useProject.getState();
    p.setRecovery(p.recovery.filter((r) => r.projectId !== projectId));
    p.setBusy(false);
  }
}

export async function discardRecovery(projectId: string) {
  await ipc.deleteRecovery(projectId).catch(() => {});
  const p = useProject.getState();
  p.setRecovery(p.recovery.filter((r) => r.projectId !== projectId));
}

/** Confirm when dirty. Returns whether the app may quit. */
export async function confirmClose(): Promise<boolean> {
  if (!(await confirmDiscard("You have unsaved changes. Quit without saving?"))) return false;
  await ipc.deleteRecovery(useDashboard.getState().doc.id).catch(() => {});
  return true;
}

let quitInFlight: Promise<boolean> | null = null;

/**
 * Close button, Quit menu item and Cmd+Q all land here. Only a confirmed quit tells the
 * backend to exit (and drop recovery snapshots); repeated requests share one prompt.
 */
export function requestQuit(): Promise<boolean> {
  quitInFlight ??= (async () => {
    try {
      if (!(await confirmClose())) return false;
      await ipc.confirmExit();
      return true;
    } catch (e) {
      toast({ tone: "error", title: "Could not quit", description: errorMessage(e) });
      return false;
    } finally {
      quitInFlight = null;
    }
  })();
  return quitInFlight;
}

/** Files handed over by the OS (double-clicked `.datacanvas`): open the first project. */
export async function openFilesFromOs(paths: string[]) {
  const target = paths.find((p) => p.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`));
  if (target) await openProject(target);
}

/** At launch: open a project the app was started with (file association). */
export async function openLaunchFiles() {
  try {
    await openFilesFromOs(await ipc.takePendingOpenFiles());
  } catch (e) {
    console.warn("could not read launch files", e);
  }
}
