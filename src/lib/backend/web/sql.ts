/** Bound SQL parameters; mirrors `SqlParam` in `src-tauri/src/db/query_builder.rs`. */
export type SqlParam = { text: string } | { int: number } | { float: number } | { bool: boolean };

export type SqlValue = string | number | boolean;

export function paramValue(p: SqlParam): SqlValue {
  if ("text" in p) return p.text;
  if ("int" in p) return p.int;
  if ("float" in p) return p.float;
  return p.bool;
}
