/** Test-only: the web backend's `Db` over DuckDB-Wasm's Node bindings (same Wasm as the browser). */

import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { dbError } from "../errors";
import { LOCKDOWN_SQL, QUERY_CONFIG, type Db } from "../db";
import { arrowRows } from "../values";

const require = createRequire(import.meta.url);

export async function openNodeDb(): Promise<Db> {
  const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  const dist = path.dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs"));
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: path.join(dist, "duckdb-mvp.wasm"), mainWorker: "" },
      eh: { mainModule: path.join(dist, "duckdb-eh.wasm"), mainWorker: "" },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  db.open({ query: QUERY_CONFIG, allowUnsignedExtensions: false });
  const conn = db.connect();
  for (const sql of LOCKDOWN_SQL) conn.query(sql);
  const outputs = new Set<string>();
  return {
    async query(sql, params) {
      try {
        if (!params?.length) return arrowRows(conn.query(sql));
        const stmt = conn.prepare(sql);
        try {
          return arrowRows(stmt.query(...params));
        } finally {
          stmt.close();
        }
      } catch (e) {
        throw dbError(e);
      }
    },
    async registerFile(name, source) {
      const bytes = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer());
      db.registerFileBuffer(name, bytes);
    },
    // The Node runtime writes COPY output to real files (relative to the working directory).
    async prepareOutput(name) {
      outputs.add(name);
    },
    async readFile(name) {
      return db.copyFileToBuffer(name);
    },
    async dropFile(name) {
      try {
        db.dropFile(name);
      } catch {
        /* already gone */
      }
      if (outputs.delete(name)) rmSync(name, { force: true });
    },
  };
}
