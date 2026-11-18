/** Entry point of the lazily loaded web backend (never imported by the desktop build). */

import type { Backend } from "../types";
import { getFile, saveBytes } from "../webFiles";
import { openBrowserDb } from "./db";
import { appError } from "./errors";
import { indexedDbRecoveryStore, memoryRecoveryStore } from "./recoveryStore";
import { WebBackend, type Settings } from "./service";

function localSettings(): Settings {
  const memory = new Map<string, string>();
  return {
    get: (k) => {
      try {
        return localStorage.getItem(`datacanvas:${k}`);
      } catch {
        return memory.get(k) ?? null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(`datacanvas:${k}`, v);
      } catch {
        memory.set(k, v);
      }
    },
  };
}

export async function createWebBackend(): Promise<Backend> {
  let db;
  try {
    db = await openBrowserDb();
  } catch (e) {
    throw appError(
      "internal",
      `Could not start the in-browser database (${e instanceof Error ? e.message : e}). Use a current version of Chrome, Edge, Firefox or Safari.`,
    );
  }
  return new WebBackend({
    db,
    recovery: typeof indexedDB === "undefined" ? memoryRecoveryStore() : indexedDbRecoveryStore(),
    settings: localSettings(),
    getFile,
    save: saveBytes,
  });
}
