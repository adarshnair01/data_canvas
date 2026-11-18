export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Display label for a shortcut such as `mod+shift+s`. */
export function shortcutLabel(combo: string): string {
  return combo
    .split("+")
    .map((k) => {
      switch (k) {
        case "mod":
          return isMac ? "⌘" : "Ctrl";
        case "shift":
          return isMac ? "⇧" : "Shift";
        case "alt":
          return isMac ? "⌥" : "Alt";
        default:
          return k.toUpperCase();
      }
    })
    .join(isMac ? "" : "+");
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function fileExtension(path: string): string {
  const name = fileName(path);
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export const CSV_EXTENSIONS = ["csv", "tsv", "txt"];
export const EXCEL_EXTENSIONS = ["xlsx", "xlsm", "xls", "xlsb", "ods"];
export const PROJECT_EXTENSION = "datacanvas";

export type DroppedFileKind = "csv" | "xlsx" | "project" | "unsupported";

export function classifyPath(path: string): DroppedFileKind {
  const ext = fileExtension(path);
  if (CSV_EXTENSIONS.includes(ext)) return "csv";
  if (EXCEL_EXTENSIONS.includes(ext)) return "xlsx";
  if (ext === PROJECT_EXTENSION) return "project";
  return "unsupported";
}
