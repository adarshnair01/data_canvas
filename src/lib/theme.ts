/** Follow the system light/dark preference by toggling `.dark` on the root element. */

import { useSyncExternalStore } from "react";

const DARK = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

export function followSystemTheme(): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(DARK);
  const apply = () => {
    document.documentElement.classList.toggle("dark", mq.matches);
    document.documentElement.style.colorScheme = mq.matches ? "dark" : "light";
    listeners.forEach((l) => l());
  };
  apply();
  mq.addEventListener("change", apply);
  return () => mq.removeEventListener("change", apply);
}

export function useIsDark(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => document.documentElement.classList.contains("dark"),
  );
}
