import { create } from "zustand";
import { useDashboard } from "@/features/dashboard/store";
import { ipc } from "@/lib/ipc";
import type { CsvOptions, DatasetMeta, LogicalType } from "@/types/dataset";

interface DataState {
  datasets: DatasetMeta[];
  selectedId: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  select: (id: string | null) => void;
  upsert: (meta: DatasetMeta) => void;
  importCsv: (path: string, options: CsvOptions, name?: string) => Promise<DatasetMeta>;
  importXlsx: (path: string, sheet: string, header: boolean, name?: string) => Promise<DatasetMeta>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setColumnType: (id: string, column: string, type: LogicalType | null) => Promise<void>;
}

/** Datasets are saved with the project, so changing them leaves unsaved changes. */
const touched = () => useDashboard.getState().markDirty();

export const useData = create<DataState>((set, get) => ({
  datasets: [],
  selectedId: null,
  loaded: false,
  refresh: async () => {
    const datasets = await ipc.listDatasets();
    set((s) => ({
      datasets,
      loaded: true,
      selectedId:
        s.selectedId && datasets.some((d) => d.id === s.selectedId) ? s.selectedId : (datasets[0]?.id ?? null),
    }));
  },
  select: (selectedId) => set({ selectedId }),
  upsert: (meta) =>
    set((s) => {
      const exists = s.datasets.some((d) => d.id === meta.id);
      return {
        datasets: exists
          ? s.datasets.map((d) => (d.id === meta.id ? meta : d))
          : [...s.datasets, meta],
      };
    }),
  importCsv: async (path, options, name) => {
    const meta = await ipc.importCsv(path, options, name);
    get().upsert(meta);
    set({ selectedId: meta.id });
    touched();
    return meta;
  },
  importXlsx: async (path, sheet, header, name) => {
    const meta = await ipc.importXlsx(path, sheet, header, name);
    get().upsert(meta);
    set({ selectedId: meta.id });
    touched();
    return meta;
  },
  rename: async (id, name) => {
    get().upsert(await ipc.renameDataset(id, name));
    touched();
  },
  remove: async (id) => {
    await ipc.removeDataset(id);
    set((s) => {
      const datasets = s.datasets.filter((d) => d.id !== id);
      return {
        datasets,
        selectedId: s.selectedId === id ? (datasets[0]?.id ?? null) : s.selectedId,
      };
    });
    touched();
  },
  setColumnType: async (id, column, type) => {
    const meta = get().datasets.find((d) => d.id === id);
    if (!meta) return;
    const overrides = { ...meta.typeOverrides };
    if (type === null) delete overrides[column];
    else overrides[column] = type;
    get().upsert(await ipc.setColumnTypes(id, overrides));
    touched();
  },
}));

export const datasetById = (id: string | null | undefined) =>
  id ? useData.getState().datasets.find((d) => d.id === id) : undefined;
