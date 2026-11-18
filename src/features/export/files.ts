/**
 * Save dialogs and file writes for exports. CSV is written by the backend; PNG/PDF bytes come
 * from here. On the web, "paths" are save-picker handles or download names.
 */

import { save } from "@tauri-apps/plugin-dialog";
import { downloadName, pickSaveTarget } from "@/lib/backend/webFiles";
import { ipc, isTauri } from "@/lib/ipc";
import { IS_WEB } from "@/lib/target";

export type ExportKind = "png" | "pdf" | "csv";

const FILTERS: Record<ExportKind, { name: string; extensions: string[] }> = {
  png: { name: "PNG image", extensions: ["png"] },
  pdf: { name: "PDF document", extensions: ["pdf"] },
  csv: { name: "CSV file", extensions: ["csv"] },
};

/** File-system-safe base name (no path separators or reserved characters). */
export function safeFileName(name: string, fallback = "Export"): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

/** How to show an export destination: the full path on desktop, the file name on the web. */
export const shownPath = (path: string) => (IS_WEB ? downloadName(path, path) : path);

export function withExtension(path: string, ext: ExportKind): string {
  return path.toLowerCase().endsWith(`.${ext}`) ? path : `${path}.${ext}`;
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0 || !dataUrl.slice(0, comma).endsWith(";base64")) {
    throw new Error("Expected a base64 data URL");
  }
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MIME: Record<ExportKind, string> = { png: "image/png", pdf: "application/pdf", csv: "text/csv" };

export async function pickExportPath(kind: ExportKind, baseName: string, title: string): Promise<string | null> {
  const defaultPath = `${safeFileName(baseName)}.${kind}`;
  if (IS_WEB) return pickSaveTarget(defaultPath, FILTERS[kind].name, kind, MIME[kind]);
  if (!isTauri()) return window.prompt(title, defaultPath);
  const path = await save({ title, defaultPath, filters: [FILTERS[kind]] });
  return path ? withExtension(path, kind) : null;
}

/** Write PNG/PDF bytes to a dialog-chosen path. In a plain browser (`pnpm dev`) this downloads instead. */
export async function writeExportBytes(path: string, bytes: Uint8Array, kind: Exclude<ExportKind, "csv">) {
  if (isTauri() || IS_WEB) return ipc.writeExportFile(path, bytes);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[kind] }));
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split(/[\\/]/).pop() || `export.${kind}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
