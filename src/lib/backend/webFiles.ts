/**
 * Browser file handles. A picked or dropped `File` is registered under an opaque "path" so the
 * UI's path-based flows (import dialog, open project, relocate) work unchanged in the web build.
 * Kept free of DuckDB so dialogs can import it cheaply.
 */

const PREFIX = "browser-file:";
const files = new Map<string, File>();
let seq = 0;

export function registerFile(file: File): string {
  const handle = `${PREFIX}${(++seq).toString(36)}${Date.now().toString(36)}/${file.name}`;
  files.set(handle, file);
  return handle;
}

export const isFileHandle = (path: string) => path.startsWith(PREFIX);

export function getFile(path: string): File | undefined {
  return files.get(path);
}

/** "sales.csv · 2.4 MB, from this computer" for a handle; the path itself otherwise. */
export function describePath(path: string): string {
  const f = files.get(path);
  if (!f) return path;
  const mb = f.size / (1024 * 1024);
  const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`;
  return `${size} · read in this browser, never uploaded`;
}

/** Native file picker. Resolves with handles, or an empty list when the user cancels. */
export function pickFiles(accept: string[], multiple = false): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept.map((e) => `.${e}`).join(",");
    input.multiple = multiple;
    input.style.display = "none";
    let settled = false;
    const done = (paths: string[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(paths);
    };
    input.addEventListener("change", () => done(Array.from(input.files ?? [], registerFile)));
    input.addEventListener("cancel", () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

const SAVE_PREFIX = "browser-save:";

interface WritableHandle {
  name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}
type SavePicker = (opts: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<WritableHandle>;

const saveTargets = new Map<string, WritableHandle>();

/**
 * Where to save: a real file chosen in Chromium's save picker (File System Access API), or just
 * a download name elsewhere. Resolves `null` when the user cancels the picker.
 */
export async function pickSaveTarget(suggestedName: string, description: string, ext: string, mime: string) {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return suggestedName;
  try {
    const handle = await picker({ suggestedName, types: [{ description, accept: { [mime]: [`.${ext}`] } }] });
    const path = `${SAVE_PREFIX}${(++seq).toString(36)}${Date.now().toString(36)}/${handle.name}`;
    saveTargets.set(path, handle);
    return path;
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return null;
    return suggestedName; // e.g. blocked without a user gesture: fall back to a download
  }
}

/** Write to a picked save target, or download under the path's file name. */
export async function saveBytes(path: string, bytes: Uint8Array, mime: string): Promise<void> {
  const handle = saveTargets.get(path);
  if (handle) {
    const w = await handle.createWritable();
    await w.write(new Blob([bytes as BlobPart], { type: mime }));
    await w.close();
    return;
  }
  downloadBytes(downloadName(path, "download"), bytes, mime);
}

/** Save bytes through a browser download (the web build's replacement for native Save dialogs). */
export function downloadBytes(name: string, bytes: Uint8Array | string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The file name a download should use for a dialog-style "path" or handle. */
export function downloadName(path: string, fallback: string) {
  return saveTargets.get(path)?.name ?? (path.split(/[\\/]/).pop() || fallback);
}
