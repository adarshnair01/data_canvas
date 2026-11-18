/** Native menu events and Finder/Explorer drag-and-drop, with keyboard fallbacks in a browser. */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { registerFile } from "./backend/webFiles";
import { isTauri } from "./ipc";
import { IS_WEB } from "./target";

export type MenuAction =
  | "new"
  | "open"
  | "save"
  | "save_as"
  | "import"
  | "undo"
  | "redo"
  | "duplicate"
  | "nav_home"
  | "nav_data"
  | "nav_dashboard";

const SHORTCUTS: { key: string; shift: boolean; action: MenuAction }[] = [
  { key: "n", shift: false, action: "new" },
  { key: "o", shift: false, action: "open" },
  { key: "s", shift: false, action: "save" },
  { key: "s", shift: true, action: "save_as" },
  { key: "i", shift: false, action: "import" },
  { key: "z", shift: false, action: "undo" },
  { key: "z", shift: true, action: "redo" },
  { key: "y", shift: false, action: "redo" },
  { key: "d", shift: false, action: "duplicate" },
  { key: "1", shift: false, action: "nav_home" },
  { key: "2", shift: false, action: "nav_data" },
  { key: "3", shift: false, action: "nav_dashboard" },
];

export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

/** Undo/redo inside a focused text field should edit the text, not the dashboard. */
function routedToTextField(action: MenuAction): boolean {
  if ((action === "undo" || action === "redo") && isTextInput(document.activeElement)) {
    document.execCommand(action);
    return true;
  }
  return false;
}

export function listenMenu(handler: (action: MenuAction) => void): () => void {
  if (isTauri()) {
    const un = listen<string>("menu", (e) => {
      const action = e.payload as MenuAction;
      if (!routedToTextField(action)) handler(action);
    });
    return () => void un.then((f) => f());
  }
  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const hit = SHORTCUTS.find((s) => s.key === e.key.toLowerCase() && s.shift === e.shiftKey);
    if (!hit) return;
    if ((hit.action === "undo" || hit.action === "redo") && isTextInput(document.activeElement)) return;
    e.preventDefault();
    handler(hit.action);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/**
 * Every way of quitting: window close button / Alt+F4 and the backend's `quit-requested`
 * (Quit menu item, Cmd+Q, OS exit request). The window never closes by itself; `onQuit`
 * confirms and asks the backend to exit.
 */
export function listenQuitRequests(onQuit: () => void): () => void {
  if (!isTauri()) return () => {};
  const unClose = getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    onQuit();
  });
  const unQuit = listen("quit-requested", () => onQuit());
  return () => {
    void unClose.then((f) => f());
    void unQuit.then((f) => f());
  };
}

/**
 * Web: closing or reloading the tab with unsaved changes shows the browser's own "Leave site?"
 * prompt. The autosave snapshot stays in browser storage, so recovery is offered next time.
 */
export function listenPageLeave(isDirty: () => boolean): () => void {
  if (!IS_WEB) return () => {};
  const onLeave = (e: BeforeUnloadEvent) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  };
  window.addEventListener("beforeunload", onLeave);
  return () => window.removeEventListener("beforeunload", onLeave);
}

/** `.datacanvas` files opened from Finder/Explorer (file association) while running. */
export function listenOpenFiles(onOpen: (paths: string[]) => void): () => void {
  if (!isTauri()) return () => {};
  const un = listen<string[]>("open-files", (e) => onOpen(e.payload));
  return () => void un.then((f) => f());
}

export type DragState = "idle" | "over";

/** Web: files dragged from the desktop onto the page become browser file handles. */
function listenBrowserDrops(onDrop: (paths: string[]) => void, onState: (s: DragState) => void): () => void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) onState("over");
  };
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      onState("idle");
    }
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    onState("idle");
    const files = Array.from(e.dataTransfer!.files);
    if (files.length) onDrop(files.map(registerFile));
  };
  window.addEventListener("dragenter", enter);
  window.addEventListener("dragover", over);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragenter", enter);
    window.removeEventListener("dragover", over);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("drop", drop);
  };
}

export function listenFileDrops(
  onDrop: (paths: string[]) => void,
  onState: (s: DragState) => void,
): () => void {
  if (IS_WEB) return listenBrowserDrops(onDrop, onState);
  if (!isTauri()) return () => {};
  const un = getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") onState("over");
    else if (p.type === "leave") onState("idle");
    else if (p.type === "drop") {
      onState("idle");
      if (p.paths.length) onDrop(p.paths);
    }
  });
  return () => void un.then((f) => f());
}
