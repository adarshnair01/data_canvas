/**
 * Autosave storage for the web build. Snapshots mirror `project/recovery.rs`; because a browser
 * cannot re-read source files later, each dataset's rows are kept too (as typed CSV).
 */

import type { ProjectDoc, ProjectFileDataset, ProjectStorageMode } from "@/types/project";
import type { TypedColumn } from "./typedCsv";

export interface RecoverySnapshot {
  formatVersion: number;
  projectId: string;
  projectPath: string | null;
  name: string;
  savedAt: string;
  mode: ProjectStorageMode;
  project: ProjectDoc;
  datasets: ProjectFileDataset[];
}

export interface StoredTable {
  datasetId: string;
  columns: TypedColumn[];
  csv: Uint8Array;
}

export interface RecoveryStore {
  putSnapshot(s: RecoverySnapshot): Promise<void>;
  getSnapshot(projectId: string): Promise<RecoverySnapshot | undefined>;
  listSnapshots(): Promise<RecoverySnapshot[]>;
  deleteSnapshot(projectId: string): Promise<void>;
  putTable(t: StoredTable): Promise<void>;
  getTable(datasetId: string): Promise<StoredTable | undefined>;
  deleteTable(datasetId: string): Promise<void>;
  tableIds(): Promise<string[]>;
}

export function memoryRecoveryStore(): RecoveryStore {
  const snaps = new Map<string, RecoverySnapshot>();
  const tables = new Map<string, StoredTable>();
  return {
    putSnapshot: async (s) => void snaps.set(s.projectId, structuredClone(s)),
    getSnapshot: async (id) => snaps.get(id),
    listSnapshots: async () => [...snaps.values()],
    deleteSnapshot: async (id) => void snaps.delete(id),
    putTable: async (t) => void tables.set(t.datasetId, t),
    getTable: async (id) => tables.get(id),
    deleteTable: async (id) => void tables.delete(id),
    tableIds: async () => [...tables.keys()],
  };
}

const DB_NAME = "datacanvas-recovery";
const SNAPSHOTS = "snapshots";
const TABLES = "tables";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function indexedDbRecoveryStore(): RecoveryStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(SNAPSHOTS, { keyPath: "projectId" });
        r.result.createObjectStore(TABLES, { keyPath: "datasetId" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const store = async (name: string, mode: IDBTransactionMode) => (await open()).transaction(name, mode).objectStore(name);
  return {
    putSnapshot: async (s) => void (await request((await store(SNAPSHOTS, "readwrite")).put(s))),
    getSnapshot: async (id) => request((await store(SNAPSHOTS, "readonly")).get(id)),
    listSnapshots: async () => request((await store(SNAPSHOTS, "readonly")).getAll()),
    deleteSnapshot: async (id) => void (await request((await store(SNAPSHOTS, "readwrite")).delete(id))),
    putTable: async (t) => void (await request((await store(TABLES, "readwrite")).put(t))),
    getTable: async (id) => request((await store(TABLES, "readonly")).get(id)),
    deleteTable: async (id) => void (await request((await store(TABLES, "readwrite")).delete(id))),
    tableIds: async () => (await request((await store(TABLES, "readonly")).getAllKeys())).map(String),
  };
}
