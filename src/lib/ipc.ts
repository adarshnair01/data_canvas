/**
 * The backend adapter the UI calls. Desktop builds use Tauri `invoke`; the web build lazily loads
 * the in-browser DuckDB-Wasm backend so its Wasm and worker are never part of the desktop bundle.
 */

import { isTauri, tauriBackend } from "./backend/tauri";
import type { Backend } from "./backend/types";

export type { Backend, ColumnLabel, ExportResult, RecentProject } from "./backend/types";
export { isTauri };

let web: Promise<Backend> | null = null;

function webBackend(): Promise<Backend> {
  web ??= import("./backend/web").then((m) => m.createWebBackend());
  return web;
}

function lazy(load: () => Promise<Backend>): Backend {
  return new Proxy({} as Backend, {
    get: (_, key: string) =>
      (...args: unknown[]) =>
        load().then((b) => (b[key as keyof Backend] as (...a: unknown[]) => Promise<unknown>)(...args)),
  });
}

export const ipc: Backend = import.meta.env.VITE_TARGET === "web" ? lazy(webBackend) : tauriBackend;
