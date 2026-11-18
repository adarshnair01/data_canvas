/**
 * Native Open/Save dialogs via tauri-plugin-dialog. The web build uses the browser file picker,
 * the save picker (or downloads) and an in-app confirm dialog; `pnpm dev` keeps prompt fallbacks.
 */

import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useUi } from "@/app/uiStore";
import { pickFiles, pickSaveTarget } from "./backend/webFiles";
import { isTauri } from "./ipc";
import { CSV_EXTENSIONS, EXCEL_EXTENSIONS, PROJECT_EXTENSION } from "./platform";
import { IS_WEB } from "./target";

export async function confirmDialog(message: string, title = "DataCanvas"): Promise<boolean> {
  if (IS_WEB) return useUi.getState().requestConfirm(message, title);
  if (!isTauri()) return window.confirm(message);
  return ask(message, { title, kind: "warning" });
}

export async function pickDataFile(): Promise<string | null> {
  if (IS_WEB) return (await pickFiles([...CSV_EXTENSIONS, ...EXCEL_EXTENSIONS]))[0] ?? null;
  if (!isTauri()) return window.prompt("Path to a CSV or Excel file", "/Users/demo/sales.csv");
  const result = await open({
    multiple: false,
    directory: false,
    title: "Import data",
    filters: [
      { name: "Data files", extensions: [...CSV_EXTENSIONS, ...EXCEL_EXTENSIONS] },
      { name: "CSV", extensions: CSV_EXTENSIONS },
      { name: "Excel", extensions: EXCEL_EXTENSIONS },
    ],
  });
  return typeof result === "string" ? result : null;
}

export async function pickProjectToOpen(): Promise<string | null> {
  if (IS_WEB) return (await pickFiles([PROJECT_EXTENSION]))[0] ?? null;
  if (!isTauri()) return window.prompt("Path to a .datacanvas project", "/Users/demo/Q3 Review.datacanvas");
  const result = await open({
    multiple: false,
    directory: false,
    title: "Open project",
    filters: [{ name: "DataCanvas project", extensions: [PROJECT_EXTENSION] }],
  });
  return typeof result === "string" ? result : null;
}

export async function pickProjectSavePath(defaultName: string): Promise<string | null> {
  const fileName = `${defaultName || "Untitled"}.${PROJECT_EXTENSION}`;
  if (IS_WEB) return pickSaveTarget(fileName, "DataCanvas project", PROJECT_EXTENSION, "application/octet-stream");
  if (!isTauri()) return window.prompt("Save project as", `/Users/demo/${fileName}`);
  return save({
    title: "Save project",
    defaultPath: fileName,
    filters: [{ name: "DataCanvas project", extensions: [PROJECT_EXTENSION] }],
  });
}
