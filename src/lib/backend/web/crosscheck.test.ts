import { describe, expect, it } from "vitest";
import fixtures from "../../../../src-tauri/tests/fixtures/crosscheck.json";
import type { ColumnInfo, LogicalType } from "@/types/dataset";
import type { QuerySpec } from "@/types/query";
import { compileExpression, parseExpression } from "./expr";
import { partialSha256 } from "./fingerprint";
import { buildQuery } from "./queryBuilder";
import type { SqlParam } from "./sql";

const schema: ColumnInfo[] = fixtures.schema.map((c) => ({
  name: c.name,
  logicalType: c.logicalType as LogicalType,
  duckType: "",
  nullCount: 0,
  distinctEstimate: 0,
}));

function attempt<T>(f: () => T): T | { error: unknown } {
  try {
    return f();
  } catch (e) {
    return { error: e };
  }
}

const normalizeAst = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("crosscheck with the Rust backend (src-tauri/tests/fixtures/crosscheck.json)", () => {
  it.each(fixtures.queries.map((q) => [q.name, q] as const))("query: %s", (_, q) => {
    const actual = attempt(() => {
      const b = buildQuery(q.spec as unknown as QuerySpec, schema);
      return { sql: b.sql, params: b.params, limit: b.limit };
    });
    expect(actual).toEqual(q.expect);
  });

  it.each(fixtures.expressions.map((e) => [e.src, e] as const))("expression: %j", (src, e) => {
    const actual = attempt(() => {
      const p = parseExpression(src, schema);
      const params: SqlParam[] = [];
      const sql = compileExpression(p.ast, params);
      return { sql, params, isAggregate: p.isAggregate, columns: p.columns, ast: normalizeAst(p.ast) };
    });
    expect(actual).toEqual(e.expect);
  });

  it.each(fixtures.fingerprints.map((f) => [f.name, f] as const))("fingerprint: %s", async (_, f) => {
    const text =
      "text" in f && typeof f.text === "string"
        ? f.text
        : (f as { repeat: string }).repeat.repeat((f as { count: number }).count) + ((f as { tail?: string }).tail ?? "");
    const blob = new Blob([new TextEncoder().encode(text)]);
    expect({ size: blob.size, partialSha256: await partialSha256(blob) }).toEqual(f.expect);
  });
});
