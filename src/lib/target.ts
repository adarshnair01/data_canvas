/**
 * Build target. `pnpm build` / `pnpm tauri ...` produce the desktop frontend; `pnpm build:web`
 * produces the browser-only build (DuckDB-Wasm, no server). Replaced at build time by Vite.
 */
export const IS_WEB = import.meta.env.VITE_TARGET === "web";

/** What the current target can do; the UI hides or explains anything that is false. */
export const capabilities = {
  /** Recent projects are file paths the app can reopen; browsers cannot reopen a file by path. */
  recentProjects: !IS_WEB,
  /** Linked mode stores paths to source files, which a browser cannot read back later. */
  linkedStorage: !IS_WEB,
  /** Native menus, file associations and the quit prompt. */
  nativeShell: !IS_WEB,
  /** Re-reading a source file without asking the user to pick it again. */
  silentReload: !IS_WEB,
};
