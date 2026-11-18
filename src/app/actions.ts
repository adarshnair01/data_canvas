import { redo, undo, useDashboard } from "@/features/dashboard/store";
import { newProject, openProject, saveProject, saveProjectAs } from "@/features/project/actions";
import type { MenuAction } from "@/lib/nativeEvents";
import { classifyPath, fileName } from "@/lib/platform";
import { toast, useUi } from "./uiStore";

export function handleMenuAction(action: MenuAction) {
  const ui = useUi.getState();
  switch (action) {
    case "new":
      return void newProject();
    case "open":
      return void openProject();
    case "save":
      return void saveProject();
    case "save_as":
      return void saveProjectAs();
    case "import":
      return ui.openImport();
    case "undo":
      return undo();
    case "redo":
      return redo();
    case "duplicate": {
      if (!ui.selectedWidgetId) return;
      const id = useDashboard.getState().duplicateWidget(ui.selectedWidgetId);
      if (id) ui.selectWidget(id);
      return;
    }
    case "nav_home":
      return ui.navigate("home");
    case "nav_data":
      return ui.navigate("data");
    case "nav_dashboard":
      return ui.navigate("dashboard");
  }
}

/** Files dropped from Finder/Explorer: data files open the import dialog, projects open. */
export function handleDroppedPaths(paths: string[]) {
  const [first, ...rest] = paths;
  if (rest.length) {
    toast({ tone: "info", title: "One file at a time", description: `Importing ${fileName(first)} only.` });
  }
  switch (classifyPath(first)) {
    case "csv":
    case "xlsx":
      return useUi.getState().openImport(first);
    case "project":
      return void openProject(first);
    default:
      toast({
        tone: "error",
        title: "Unsupported file",
        description: `${fileName(first)} is not a CSV, Excel or .datacanvas file.`,
      });
  }
}
