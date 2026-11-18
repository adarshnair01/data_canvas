/**
 * Calculated-metric expressions: a port of `src-tauri/src/db/expr.rs` (same grammar, AST, error
 * messages and SQL). Raw SQL never passes through: identifiers are resolved against the schema
 * and quoted, strings are bound as parameters and numbers are re-serialised.
 */

import type { ColumnInfo } from "@/types/dataset";
import type { AggFunc, BinaryOp, MetricExprAst, ParsedExpression, ScalarFunc } from "@/types/metrics";
import { exprError } from "./errors";
import { quoteIdent } from "./ident";
import type { SqlParam } from "./sql";

export const MAX_EXPRESSION_LEN = 2000;
const MAX_DEPTH = 32;
const MAX_ARGS = 16;

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "bracket"; v: string }
  | { t: "(" | ")" | "," | "+" | "-" | "*" | "/" | "%" | "=" | "!=" | "<" | "<=" | ">" | ">=" };

const isWhitespace = (c: string) => /\s/u.test(c);
const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";
const isAlphabetic = (c: string) => /\p{Alphabetic}/u.test(c);
const isAlphanumeric = (c: string) => /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u.test(c);
const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function lex(src: string): [Tok, number][] {
  const chars = Array.from(src);
  const out: [Tok, number][] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    const start = i;
    if (isWhitespace(c)) {
      i++;
      continue;
    }
    let tok: Tok;
    switch (c) {
      case "(":
      case ")":
      case ",":
      case "+":
      case "-":
      case "*":
      case "/":
      case "%":
        tok = { t: c };
        break;
      case "=":
        if (chars[i + 1] === "=") i++;
        tok = { t: "=" };
        break;
      case "<":
        if (chars[i + 1] === "=") {
          i++;
          tok = { t: "<=" };
        } else if (chars[i + 1] === ">") {
          i++;
          tok = { t: "!=" };
        } else tok = { t: "<" };
        break;
      case ">":
        if (chars[i + 1] === "=") {
          i++;
          tok = { t: ">=" };
        } else tok = { t: ">" };
        break;
      case "'":
      case '"': {
        let s = "";
        i++;
        for (;;) {
          const ch = chars[i];
          if (ch === undefined) throw exprError("unterminated string", start);
          if (ch === c) {
            if (chars[i + 1] === c) {
              s += c;
              i += 2;
            } else break;
          } else {
            s += ch;
            i++;
          }
        }
        tok = { t: "str", v: s };
        break;
      }
      case "[": {
        let s = "";
        i++;
        for (;;) {
          const ch = chars[i];
          if (ch === undefined) throw exprError("unterminated column reference", start);
          if (ch === "]") break;
          s += ch;
          i++;
        }
        if (!s.trim()) throw exprError("empty column reference", start);
        tok = { t: "bracket", v: s };
        break;
      }
      default:
        if (c === "!" && chars[i + 1] === "=") {
          i++;
          tok = { t: "!=" };
        } else if (isDigit(c) || c === ".") {
          let s = "";
          for (;;) {
            const ch = chars[i];
            if (isDigit(ch) || ch === ".") {
              s += ch;
              i++;
            } else if ((ch === "e" || ch === "E") && (isDigit(chars[i + 1]) || chars[i + 1] === "-" || chars[i + 1] === "+")) {
              s += ch + chars[i + 1];
              i += 2;
            } else break;
          }
          i--;
          if (!NUMBER.test(s)) throw exprError(`invalid number '${s}'`, start);
          const v = Number(s);
          if (!Number.isFinite(v)) throw exprError("number out of range", start);
          tok = { t: "num", v };
        } else if (isAlphabetic(c) || c === "_") {
          let s = "";
          while (i < chars.length && (isAlphanumeric(chars[i]) || chars[i] === "_")) s += chars[i++];
          i--;
          tok = { t: "ident", v: s };
        } else {
          throw exprError(`unexpected character '${c}'`, start);
        }
    }
    out.push([tok, start]);
    i++;
  }
  return out;
}

const bin = (op: BinaryOp, left: MetricExprAst, right: MetricExprAst): MetricExprAst => ({
  type: "binary",
  op,
  left,
  right,
});

const COMPARISON: Partial<Record<Tok["t"], BinaryOp>> = {
  "=": "eq",
  "!=": "neq",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};

const AGGREGATES: Record<string, AggFunc> = {
  SUM: "sum",
  AVG: "avg",
  MIN: "min",
  MAX: "max",
  COUNT: "count",
  COUNT_DISTINCT: "count_distinct",
};

const FUNCS: Record<string, ScalarFunc> = { IF: "if", ROUND: "round", ABS: "abs", COALESCE: "coalesce" };

class Parser {
  pos = 0;
  depth = 0;
  constructor(
    readonly toks: [Tok, number][],
    readonly end: number,
    readonly columns: ColumnInfo[],
  ) {}

  peek(): Tok | undefined {
    return this.toks[this.pos]?.[0];
  }
  offset(): number {
    return this.toks[this.pos]?.[1] ?? this.end;
  }
  bump(): Tok | undefined {
    return this.toks[this.pos++]?.[0];
  }
  expect(t: Tok["t"], what: string) {
    if (this.peek()?.t === t) this.pos++;
    else throw exprError(`expected ${what}`, this.offset());
  }
  keyword(kw: string): boolean {
    const p = this.peek();
    return p?.t === "ident" && p.v.toUpperCase() === kw;
  }
  enter() {
    this.depth++;
    if (this.depth > MAX_DEPTH) throw exprError("expression is nested too deeply", this.offset());
  }

  expr(): MetricExprAst {
    this.enter();
    let left = this.and();
    while (this.keyword("OR")) {
      this.pos++;
      left = bin("or", left, this.and());
    }
    this.depth--;
    return left;
  }
  and(): MetricExprAst {
    let left = this.not();
    while (this.keyword("AND")) {
      this.pos++;
      left = bin("and", left, this.not());
    }
    return left;
  }
  not(): MetricExprAst {
    if (this.keyword("NOT")) {
      this.pos++;
      this.enter();
      const operand = this.not();
      this.depth--;
      return { type: "unary", op: "not", operand };
    }
    return this.comparison();
  }
  comparison(): MetricExprAst {
    const left = this.additive();
    const p = this.peek();
    const op = p ? COMPARISON[p.t] : undefined;
    if (!op) return left;
    this.pos++;
    return bin(op, left, this.additive());
  }
  additive(): MetricExprAst {
    let left = this.term();
    for (;;) {
      const t = this.peek()?.t;
      if (t !== "+" && t !== "-") return left;
      this.pos++;
      left = bin(t === "+" ? "add" : "sub", left, this.term());
    }
  }
  term(): MetricExprAst {
    let left = this.unary();
    for (;;) {
      const t = this.peek()?.t;
      if (t !== "*" && t !== "/" && t !== "%") return left;
      this.pos++;
      left = bin(t === "*" ? "mul" : t === "/" ? "div" : "mod", left, this.unary());
    }
  }
  unary(): MetricExprAst {
    if (this.peek()?.t === "-") {
      this.pos++;
      this.enter();
      const operand = this.unary();
      this.depth--;
      return { type: "unary", op: "neg", operand };
    }
    return this.primary();
  }
  primary(): MetricExprAst {
    const at = this.offset();
    const tok = this.bump();
    if (!tok) throw exprError("unexpected end of expression", at);
    switch (tok.t) {
      case "num":
        return { type: "number", value: tok.v };
      case "str":
        return { type: "string", value: tok.v };
      case "(": {
        const e = this.expr();
        this.expect(")", "')'");
        return e;
      }
      case "bracket":
        return this.column(tok.v, at);
      case "ident": {
        if (this.peek()?.t === "(") {
          this.pos++;
          return this.call(tok.v, at);
        }
        switch (tok.v.toUpperCase()) {
          case "TRUE":
            return { type: "boolean", value: true };
          case "FALSE":
            return { type: "boolean", value: false };
          case "NULL":
            return { type: "null" };
          case "AND":
          case "OR":
          case "NOT":
            throw exprError(`unexpected keyword '${tok.v}'`, at);
          default:
            return this.column(tok.v, at);
        }
      }
      default:
        throw exprError("unexpected token", at);
    }
  }
  column(raw: string, at: number): MetricExprAst {
    const name = raw.trim();
    const exact = this.columns.find((c) => c.name === name);
    if (exact) return { type: "column", name: exact.name };
    const ci = this.columns.filter((c) => c.name.toLowerCase() === name.toLowerCase());
    if (ci.length === 1) return { type: "column", name: ci[0].name };
    if (!ci.length) throw exprError(`unknown column '${name}'`, at);
    throw exprError(`ambiguous column '${name}', use exact case`, at);
  }
  args(): MetricExprAst[] {
    const args: MetricExprAst[] = [];
    if (this.peek()?.t === ")") {
      this.pos++;
      return args;
    }
    for (;;) {
      args.push(this.expr());
      if (args.length > MAX_ARGS) throw exprError("too many arguments", this.offset());
      const t = this.bump()?.t;
      if (t === ",") continue;
      if (t === ")") return args;
      throw exprError("expected ',' or ')'", this.offset());
    }
  }
  call(name: string, at: number): MetricExprAst {
    const upper = name.toUpperCase();
    const agg = AGGREGATES[upper];
    if (agg) {
      if (agg === "count" && this.peek()?.t === "*") {
        this.pos++;
        this.expect(")", "')'");
        return { type: "aggregate", func: agg, arg: null };
      }
      const args = this.args();
      if (args.length !== 1) throw exprError(`${upper} takes exactly one argument`, at);
      return { type: "aggregate", func: agg, arg: args[0] };
    }
    const func = FUNCS[upper];
    if (!func) {
      throw exprError(
        `unknown function '${name}'. Allowed: IF, ROUND, ABS, COALESCE, SUM, AVG, MIN, MAX, COUNT, COUNT_DISTINCT`,
        at,
      );
    }
    const args = this.args();
    const digitsOk = (a: MetricExprAst | undefined) =>
      !a || (a.type === "number" && Number.isInteger(a.value) && a.value <= 15);
    const ok =
      func === "if"
        ? args.length === 3
        : func === "round"
          ? (args.length === 1 || args.length === 2) && digitsOk(args[1])
          : func === "abs"
            ? args.length === 1
            : args.length > 0;
    if (!ok) {
      const usage = {
        if: "IF(condition, then, else)",
        round: "ROUND(value[, digits]) with an integer literal for digits",
        abs: "ABS(value)",
        coalesce: "COALESCE(value, ...)",
      }[func];
      throw exprError(`usage: ${usage}`, at);
    }
    return { type: "call", func, args };
  }
}

interface Analysis {
  hasAggregate: boolean;
  bareColumn: boolean;
  columns: string[];
}

function analyse(e: MetricExprAst, insideAgg: boolean, a: Analysis) {
  switch (e.type) {
    case "column":
      if (!insideAgg) a.bareColumn = true;
      if (!a.columns.includes(e.name)) a.columns.push(e.name);
      return;
    case "unary":
      return analyse(e.operand, insideAgg, a);
    case "binary":
      analyse(e.left, insideAgg, a);
      return analyse(e.right, insideAgg, a);
    case "call":
      for (const arg of e.args) analyse(arg, insideAgg, a);
      return;
    case "aggregate":
      if (insideAgg) throw exprError("aggregates cannot be nested", 0);
      a.hasAggregate = true;
      if (e.arg) analyse(e.arg, true, a);
      return;
  }
}

export function parseExpression(src: string, columns: ColumnInfo[]): ParsedExpression {
  if (!src.trim()) throw exprError("expression is empty", 0);
  const byteLen = new TextEncoder().encode(src).length;
  if (byteLen > MAX_EXPRESSION_LEN) throw exprError("expression is too long", MAX_EXPRESSION_LEN);
  const p = new Parser(lex(src), byteLen, columns);
  const ast = p.expr();
  if (p.pos < p.toks.length) throw exprError("unexpected input after expression", p.offset());
  const a: Analysis = { hasAggregate: false, bareColumn: false, columns: [] };
  analyse(ast, false, a);
  if (a.hasAggregate && a.bareColumn) {
    throw exprError(
      "columns outside an aggregate cannot be mixed with aggregates; wrap them in SUM/AVG/MIN/MAX/COUNT",
      0,
    );
  }
  return { ast, isAggregate: a.hasAggregate, columns: a.columns };
}

/** Same text as Rust's `{:?}` for `f64`, so both targets emit identical SQL. */
export function rustFloatDebug(v: number): string {
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) return v.toExponential().replace("e+", "e");
  const s = String(v);
  return Number.isInteger(v) ? `${s}.0` : s;
}

export function numberSql(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v === 0 ? 0 : v);
  return rustFloatDebug(v);
}

const SYMBOLS: Record<Exclude<BinaryOp, "div" | "mod">, string> = {
  add: "+",
  sub: "-",
  mul: "*",
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  and: "AND",
  or: "OR",
};

export function compileExpression(e: MetricExprAst, params: SqlParam[]): string {
  switch (e.type) {
    case "number":
      return numberSql(e.value);
    case "string":
      params.push({ text: e.value });
      return "?";
    case "boolean":
      return e.value ? "TRUE" : "FALSE";
    case "null":
      return "NULL";
    case "column":
      return quoteIdent(e.name);
    case "unary": {
      const inner = compileExpression(e.operand, params);
      return e.op === "neg" ? `(-${inner})` : `(NOT ${inner})`;
    }
    case "binary": {
      const l = compileExpression(e.left, params);
      const r = compileExpression(e.right, params);
      if (e.op === "div") return `(${l} / NULLIF(${r}, 0))`;
      if (e.op === "mod") return `(${l} % NULLIF(${r}, 0))`;
      return `(${l} ${SYMBOLS[e.op]} ${r})`;
    }
    case "call": {
      const a = e.args.map((x) => compileExpression(x, params));
      switch (e.func) {
        case "if":
          return `(CASE WHEN ${a[0]} THEN ${a[1]} ELSE ${a[2]} END)`;
        case "round":
          return `round(${a.join(", ")})`;
        case "abs":
          return `abs(${a[0]})`;
        case "coalesce":
          return `coalesce(${a.join(", ")})`;
      }
      break;
    }
    case "aggregate": {
      if (!e.arg) return "count(*)";
      const inner = compileExpression(e.arg, params);
      return e.func === "count_distinct" ? `count(DISTINCT ${inner})` : `${e.func}(${inner})`;
    }
  }
  throw new Error("unreachable");
}
