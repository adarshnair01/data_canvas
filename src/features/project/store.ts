import { create } from "zustand";
import { IS_WEB } from "@/lib/target";
import type { DatasetLoad, ProjectStorageMode, RecoverySummary } from "@/types/project";

interface ProjectState {
  /** File the project was opened from or last saved to; `null` until first save. */
  path: string | null;
  mode: ProjectStorageMode;
  /** Datasets that need a decision after open: missing, failed or changed on disk. */
  issues: DatasetLoad[];
  /** Snapshots left by a session that did not exit cleanly. */
  recovery: RecoverySummary[];
  busy: boolean;
  setPath: (path: string | null) => void;
  setMode: (mode: ProjectStorageMode) => void;
  setIssues: (issues: DatasetLoad[]) => void;
  resolveIssue: (datasetId: string) => void;
  setRecovery: (recovery: RecoverySummary[]) => void;
  setBusy: (busy: boolean) => void;
}

export const useProject = create<ProjectState>((set) => ({
  path: null,
  // The web build can only save Portable projects (it cannot re-read linked files later).
  mode: IS_WEB ? "portable" : "linked",
  issues: [],
  recovery: [],
  busy: false,
  setPath: (path) => set({ path }),
  setMode: (mode) => set({ mode }),
  setIssues: (issues) => set({ issues }),
  resolveIssue: (id) => set((s) => ({ issues: s.issues.filter((i) => i.id !== id) })),
  setRecovery: (recovery) => set({ recovery }),
  setBusy: (busy) => set({ busy }),
}));
