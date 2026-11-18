/** Calculated metrics. AST mirrors `src-tauri/src/db/expr.rs` (`Expr`). */

export type UnaryOp = "neg" | "not";
export type BinaryOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "mod"
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "and"
  | "or";
export type ScalarFunc = "if" | "round" | "abs" | "coalesce";
export type AggFunc = "sum" | "avg" | "min" | "max" | "count" | "count_distinct";

export type MetricExprAst =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "null" }
  | { type: "column"; name: string }
  | { type: "unary"; op: UnaryOp; operand: MetricExprAst }
  | { type: "binary"; op: BinaryOp; left: MetricExprAst; right: MetricExprAst }
  | { type: "call"; func: ScalarFunc; args: MetricExprAst[] }
  /** `arg` absent means COUNT(*). */
  | { type: "aggregate"; func: AggFunc; arg?: MetricExprAst | null };

export interface ParsedExpression {
  ast: MetricExprAst;
  isAggregate: boolean;
  columns: string[];
}

export interface CalculatedMetric {
  id: string;
  name: string;
  datasetId: string;
  /** Source text in the whitelisted grammar; compiled to SQL only in Rust. */
  expression: string;
  /** Cached from the last successful parse. */
  isAggregate: boolean;
}

export const METRIC_FUNCTIONS = [
  "IF(cond, a, b)",
  "ROUND(x, n)",
  "ABS(x)",
  "COALESCE(a, b)",
  "SUM(x)",
  "AVG(x)",
  "MIN(x)",
  "MAX(x)",
  "COUNT(*)",
  "COUNT_DISTINCT(x)",
] as const;
