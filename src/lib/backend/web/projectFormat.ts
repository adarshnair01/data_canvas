/**
 * `.datacanvas` archive I/O in the browser; a port of `src-tauri/src/project/format.rs`.
 *
 * - `manifest.json`: `{ formatVersion, appVersion }`
 * - `project.json`: storage mode, the `ProjectDoc` and every dataset with schema and fingerprint
 * - `data/<id>.parquet` (desktop Portable) or `data/<id>.csv` (web Portable: this Wasm build has
 *   no Parquet writer). Desktop reads both.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import pkg from "../../../../package.json";
import type { ProjectFile, ProjectManifest } from "@/types/project";
import { PROJECT_FORMAT_VERSION } from "@/types/project";
import { appError } from "./errors";

export const APP_VERSION = pkg.version;
export const MANIFEST_ENTRY = "manifest.json";
export const PROJECT_ENTRY = "project.json";

export const embeddedCsvEntry = (datasetId: string) => `data/${datasetId}.csv`;

const invalid = (msg: string) => appError("unsupportedFile", `not a valid DataCanvas project: ${msg}`);

/** Upgrade a `project.json` value written with format `from` to the current one. */
export function migrate(project: unknown, from: number): unknown {
  if (from > PROJECT_FORMAT_VERSION) {
    throw appError(
      "unsupportedFile",
      `this project was saved by a newer DataCanvas (format ${from}); this build reads format ${PROJECT_FORMAT_VERSION} and older`,
    );
  }
  let v = project;
  for (let version = from; version < PROJECT_FORMAT_VERSION; version++) {
    if (version !== 0) throw invalid(`no migration from format ${version}`);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("project.json is not an object");
    const o = { ...(v as Record<string, unknown>) };
    if ("doc" in o) {
      o.project ??= o.doc;
      delete o.doc;
    }
    o.mode ??= "linked";
    o.savedAt ??= "";
    o.datasets ??= [];
    v = o;
  }
  return v;
}

const pretty = (v: unknown) => strToU8(JSON.stringify(v, null, 2));

/** Build the archive. Embedded data is stored with fast deflate; JSON with the default level. */
export function writeArchive(project: ProjectFile, embedded: Map<string, Uint8Array>): Uint8Array {
  const manifest: ProjectManifest = { formatVersion: PROJECT_FORMAT_VERSION, appVersion: APP_VERSION };
  const files: Zippable = {
    [MANIFEST_ENTRY]: pretty(manifest),
    [PROJECT_ENTRY]: pretty(project),
  };
  for (const [entry, bytes] of embedded) files[entry] = [bytes, { level: 1 }];
  return zipSync(files, { level: 6 });
}

export interface LoadedArchive {
  manifest: ProjectManifest;
  project: ProjectFile;
  migratedFrom: number | null;
  entries: Record<string, Uint8Array>;
}

export function readArchive(bytes: Uint8Array): LoadedArchive {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : String(e));
  }
  const json = (name: string) => {
    const raw = entries[name];
    if (!raw) throw invalid(`missing ${name}`);
    try {
      return JSON.parse(strFromU8(raw));
    } catch (e) {
      throw invalid(`${name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  const m = json(MANIFEST_ENTRY) as Partial<ProjectManifest>;
  const manifest: ProjectManifest = { formatVersion: m.formatVersion ?? 0, appVersion: m.appVersion ?? "" };
  const project = migrate(json(PROJECT_ENTRY), manifest.formatVersion) as ProjectFile;
  if (!project || !("project" in project) || !Array.isArray(project.datasets) || !["linked", "portable"].includes(project.mode)) {
    throw invalid("project.json: missing fields");
  }
  return {
    manifest,
    project,
    migratedFrom: manifest.formatVersion < PROJECT_FORMAT_VERSION ? manifest.formatVersion : null,
    entries,
  };
}
