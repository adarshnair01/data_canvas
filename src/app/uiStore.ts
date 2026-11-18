import { create } from "zustand";

export type Route = "home" | "data" | "dashboard";

export interface Toast {
  id: number;
  tone: "info" | "success" | "error";
  title: string;
  description?: string;
}

export interface ConfirmRequest {
  id: number;
  title: string;
  message: string;
  resolve: (ok: boolean) => void;
}

interface UiState {
  route: Route;
  /** In-app confirmation (web build; desktop uses native dialogs). */
  confirm: ConfirmRequest | null;
  /** Label of the export in progress, shown in the progress pill. */
  exporting: string | null;
  setExporting: (label: string | null) => void;
  requestConfirm: (message: string, title?: string) => Promise<boolean>;
  answerConfirm: (ok: boolean) => void;
  selectedWidgetId: string | null;
  importPath: string | null;
  importOpen: boolean;
  metricsOpen: boolean;
  dragOver: boolean;
  toasts: Toast[];
  navigate: (r: Route) => void;
  selectWidget: (id: string | null) => void;
  openImport: (path?: string | null) => void;
  closeImport: () => void;
  setMetricsOpen: (open: boolean) => void;
  setDragOver: (over: boolean) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;

let confirmId = 0;

export const useUi = create<UiState>((set, get) => ({
  route: "home",
  confirm: null,
  exporting: null,
  setExporting: (exporting) => set({ exporting }),
  requestConfirm: (message, title = "DataCanvas") =>
    new Promise<boolean>((resolve) => {
      get().confirm?.resolve(false);
      set({ confirm: { id: ++confirmId, title, message, resolve } });
    }),
  answerConfirm: (ok) => {
    const c = get().confirm;
    if (!c) return;
    set({ confirm: null });
    c.resolve(ok);
  },
  selectedWidgetId: null,
  importPath: null,
  importOpen: false,
  metricsOpen: false,
  dragOver: false,
  toasts: [],
  navigate: (route) => set({ route }),
  selectWidget: (selectedWidgetId) => set({ selectedWidgetId }),
  openImport: (path = null) => set({ importOpen: true, importPath: path }),
  closeImport: () => set({ importOpen: false, importPath: null }),
  setMetricsOpen: (metricsOpen) => set({ metricsOpen }),
  setDragOver: (dragOver) => set({ dragOver }),
  toast: (t) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export const toast = (t: Omit<Toast, "id">) => useUi.getState().toast(t);
