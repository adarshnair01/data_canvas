/**
 * Thin async interface over DuckDB-Wasm so the web backend runs the same code in the browser
 * (worker-based `AsyncDuckDB`) and in tests (Node blocking bindings).
 */

import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { CellValue } from "@/types/dataset";
import { dbError } from "./errors";
import type { SqlValue } from "./sql";
import { arrowRows, type ArrowLike, type Rows } from "./values";

export interface Db {
  query(sql: string, params?: SqlValue[]): Promise<Rows>;
  /** Make a user file (read lazily) or bytes readable by SQL under `name`. */
  registerFile(name: string, source: Blob | Uint8Array): Promise<void>;
  /**
   * Called before `COPY ... TO name`. The browser runtime buffers such files in memory (its worker
   * logs "Buffering missing file"); the Node test runtime writes real files and cleans them up.
   */
  prepareOutput(name: string): Promise<void>;
  /** Bytes of a file written by SQL (`COPY ... TO name`). */
  readFile(name: string): Promise<Uint8Array>;
  dropFile(name: string): Promise<void>;
}

/** Statements run once per database: never fetch or load extensions from the network. */
export const LOCKDOWN_SQL = [
  "SET autoinstall_known_extensions = false",
  "SET autoload_known_extensions = false",
  "SET allow_community_extensions = false",
  "SET custom_extension_repository = 'file:///datacanvas-no-extensions'",
  "SET autoinstall_extension_repository = 'file:///datacanvas-no-extensions'",
  "SET lock_configuration = true",
];

export const QUERY_CONFIG = { castBigIntToDouble: true, castDecimalToDouble: true } as const;

export async function scalar(db: Db, sql: string, params?: SqlValue[]): Promise<CellValue> {
  const r = await db.query(sql, params);
  return r.rows[0]?.[0] ?? null;
}

interface AsyncConn {
  query(sql: string): Promise<ArrowLike>;
  prepare(sql: string): Promise<{ query(...p: unknown[]): Promise<ArrowLike>; close(): Promise<void> }>;
}

interface AsyncDb {
  registerFileHandle(name: string, handle: unknown, protocol: number, directIO: boolean): Promise<void>;
  registerFileBuffer(name: string, buffer: Uint8Array): Promise<void>;
  copyFileToBuffer(name: string): Promise<Uint8Array>;
  dropFile(name: string): Promise<void>;
}

/** Wrap an `AsyncDuckDB` + connection. Queries are serialised, as on one desktop connection. */
export function wrapAsync(db: AsyncDb, conn: AsyncConn, browserFileReader: number): Db {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = chain.then(f, f);
    chain = next.catch(() => {});
    return next;
  };
  return {
    query: (sql, params) =>
      serial(async () => {
        try {
          if (!params?.length) return arrowRows(await conn.query(sql));
          const stmt = await conn.prepare(sql);
          try {
            return arrowRows(await stmt.query(...params));
          } finally {
            await stmt.close();
          }
        } catch (e) {
          throw dbError(e);
        }
      }),
    registerFile: (name, source) =>
      source instanceof Uint8Array
        ? db.registerFileBuffer(name, source)
        : db.registerFileHandle(name, source, browserFileReader, true),
    prepareOutput: async () => {},
    readFile: (name) => serial(() => db.copyFileToBuffer(name)),
    dropFile: (name) => db.dropFile(name).catch(() => {}),
  };
}

/** Browser: the bundled EH/MVP Wasm and workers are emitted as same-origin assets by Vite. */
export async function openBrowserDb(): Promise<Db> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({ query: QUERY_CONFIG, allowUnsignedExtensions: false });
  const conn = await db.connect();
  for (const sql of LOCKDOWN_SQL) await conn.query(sql);
  return wrapAsync(
    db as unknown as AsyncDb,
    conn as unknown as AsyncConn,
    duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
  );
}
