//! Calculated-metric expressions.
//!
//! A small whitelisted grammar is parsed into an AST and compiled to SQL. Raw SQL never passes
//! through: identifiers are resolved against the dataset schema and quoted, string literals are
//! bound as parameters and numbers are re-serialised from their parsed value.
//!
//! ```text
//! expr       := or
//! or         := and ("OR" and)*
//! and        := not ("AND" not)*
//! not        := "NOT" not | comparison
//! comparison := additive (("=" | "!=" | "<>" | "<" | "<=" | ">" | ">=") additive)?
//! additive   := term (("+" | "-") term)*
//! term       := unary (("*" | "/" | "%") unary)*
//! unary      := "-" unary | primary
//! primary    := NUMBER | STRING | TRUE | FALSE | NULL | column | call | "(" expr ")"
//! column     := IDENT | "[" any chars except "]" "]"
//! call       := FUNC "(" [args] ")"   FUNC in IF ROUND ABS COALESCE SUM AVG MIN MAX COUNT COUNT_DISTINCT
//! ```

use serde::{Deserialize, Serialize};

use crate::db::ident::quote_ident;
use crate::db::query_builder::SqlParam;
use crate::error::{AppError, AppResult};
use crate::model::ColumnInfo;

pub const MAX_EXPRESSION_LEN: usize = 2000;
const MAX_DEPTH: usize = 32;
const MAX_ARGS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnaryOp {
    Neg,
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Func {
    If,
    Round,
    Abs,
    Coalesce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AggFunc {
    Sum,
    Avg,
    Min,
    Max,
    Count,
    CountDistinct,
}

/// Serialised to the frontend as `MetricExprAst` (`src/types/metrics.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Expr {
    Number { value: f64 },
    String { value: String },
    Boolean { value: bool },
    Null,
    Column { name: String },
    Unary { op: UnaryOp, operand: Box<Expr> },
    Binary { op: BinaryOp, left: Box<Expr>, right: Box<Expr> },
    Call { func: Func, args: Vec<Expr> },
    /// `arg: None` means `COUNT(*)`.
    Aggregate { func: AggFunc, arg: Option<Box<Expr>> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedExpression {
    pub ast: Expr,
    pub is_aggregate: bool,
    pub columns: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// Lexer

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    Bracket(String),
    LParen,
    RParen,
    Comma,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
}

fn lex(src: &str) -> AppResult<Vec<(Tok, usize)>> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let start = i;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let tok = match c {
            '(' => Tok::LParen,
            ')' => Tok::RParen,
            ',' => Tok::Comma,
            '+' => Tok::Plus,
            '-' => Tok::Minus,
            '*' => Tok::Star,
            '/' => Tok::Slash,
            '%' => Tok::Percent,
            '=' => {
                if chars.get(i + 1) == Some(&'=') {
                    i += 1;
                }
                Tok::Eq
            }
            '!' if chars.get(i + 1) == Some(&'=') => {
                i += 1;
                Tok::Neq
            }
            '<' => match chars.get(i + 1) {
                Some('=') => {
                    i += 1;
                    Tok::Lte
                }
                Some('>') => {
                    i += 1;
                    Tok::Neq
                }
                _ => Tok::Lt,
            },
            '>' => {
                if chars.get(i + 1) == Some(&'=') {
                    i += 1;
                    Tok::Gte
                } else {
                    Tok::Gt
                }
            }
            '\'' | '"' => {
                let quote = c;
                let mut s = String::new();
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(AppError::expr("unterminated string", start)),
                        Some(&ch) if ch == quote => {
                            if chars.get(i + 1) == Some(&quote) {
                                s.push(quote);
                                i += 2;
                            } else {
                                break;
                            }
                        }
                        Some(&ch) => {
                            s.push(ch);
                            i += 1;
                        }
                    }
                }
                Tok::Str(s)
            }
            '[' => {
                let mut s = String::new();
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(AppError::expr("unterminated column reference", start)),
                        Some(']') => break,
                        Some(&ch) => {
                            s.push(ch);
                            i += 1;
                        }
                    }
                }
                if s.trim().is_empty() {
                    return Err(AppError::expr("empty column reference", start));
                }
                Tok::Bracket(s)
            }
            c if c.is_ascii_digit() || c == '.' => {
                let mut s = String::new();
                while let Some(&ch) = chars.get(i) {
                    if ch.is_ascii_digit() || ch == '.' {
                        s.push(ch);
                        i += 1;
                    } else if (ch == 'e' || ch == 'E')
                        && chars
                            .get(i + 1)
                            .is_some_and(|n| n.is_ascii_digit() || *n == '-' || *n == '+')
                    {
                        s.push(ch);
                        s.push(chars[i + 1]);
                        i += 2;
                    } else {
                        break;
                    }
                }
                i -= 1;
                let v: f64 = s
                    .parse()
                    .map_err(|_| AppError::expr(format!("invalid number '{s}'"), start))?;
                if !v.is_finite() {
                    return Err(AppError::expr("number out of range", start));
                }
                Tok::Num(v)
            }
            c if c.is_alphabetic() || c == '_' => {
                let mut s = String::new();
                while let Some(&ch) = chars.get(i) {
                    if ch.is_alphanumeric() || ch == '_' {
                        s.push(ch);
                        i += 1;
                    } else {
                        break;
                    }
                }
                i -= 1;
                Tok::Ident(s)
            }
            other => {
                return Err(AppError::expr(
                    format!("unexpected character '{other}'"),
                    start,
                ))
            }
        };
        out.push((tok, start));
        i += 1;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Parser

struct Parser<'a> {
    toks: Vec<(Tok, usize)>,
    pos: usize,
    end: usize,
    depth: usize,
    columns: &'a [ColumnInfo],
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos).map(|(t, _)| t)
    }

    fn offset(&self) -> usize {
        self.toks.get(self.pos).map(|(_, p)| *p).unwrap_or(self.end)
    }

    fn bump(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).map(|(t, _)| t.clone());
        self.pos += 1;
        t
    }

    fn expect(&mut self, tok: Tok, what: &str) -> AppResult<()> {
        if self.peek() == Some(&tok) {
            self.pos += 1;
            Ok(())
        } else {
            Err(AppError::expr(format!("expected {what}"), self.offset()))
        }
    }

    fn keyword(&self, kw: &str) -> bool {
        matches!(self.peek(), Some(Tok::Ident(s)) if s.eq_ignore_ascii_case(kw))
    }

    fn enter(&mut self) -> AppResult<()> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            Err(AppError::expr("expression is nested too deeply", self.offset()))
        } else {
            Ok(())
        }
    }

    fn expr(&mut self) -> AppResult<Expr> {
        self.enter()?;
        let mut left = self.and()?;
        while self.keyword("OR") {
            self.pos += 1;
            let right = self.and()?;
            left = bin(BinaryOp::Or, left, right);
        }
        self.depth -= 1;
        Ok(left)
    }

    fn and(&mut self) -> AppResult<Expr> {
        let mut left = self.not()?;
        while self.keyword("AND") {
            self.pos += 1;
            let right = self.not()?;
            left = bin(BinaryOp::And, left, right);
        }
        Ok(left)
    }

    fn not(&mut self) -> AppResult<Expr> {
        if self.keyword("NOT") {
            self.pos += 1;
            self.enter()?;
            let operand = self.not()?;
            self.depth -= 1;
            return Ok(Expr::Unary {
                op: UnaryOp::Not,
                operand: Box::new(operand),
            });
        }
        self.comparison()
    }

    fn comparison(&mut self) -> AppResult<Expr> {
        let left = self.additive()?;
        let op = match self.peek() {
            Some(Tok::Eq) => BinaryOp::Eq,
            Some(Tok::Neq) => BinaryOp::Neq,
            Some(Tok::Lt) => BinaryOp::Lt,
            Some(Tok::Lte) => BinaryOp::Lte,
            Some(Tok::Gt) => BinaryOp::Gt,
            Some(Tok::Gte) => BinaryOp::Gte,
            _ => return Ok(left),
        };
        self.pos += 1;
        let right = self.additive()?;
        Ok(bin(op, left, right))
    }

    fn additive(&mut self) -> AppResult<Expr> {
        let mut left = self.term()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Plus) => BinaryOp::Add,
                Some(Tok::Minus) => BinaryOp::Sub,
                _ => return Ok(left),
            };
            self.pos += 1;
            let right = self.term()?;
            left = bin(op, left, right);
        }
    }

    fn term(&mut self) -> AppResult<Expr> {
        let mut left = self.unary()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Star) => BinaryOp::Mul,
                Some(Tok::Slash) => BinaryOp::Div,
                Some(Tok::Percent) => BinaryOp::Mod,
                _ => return Ok(left),
            };
            self.pos += 1;
            let right = self.unary()?;
            left = bin(op, left, right);
        }
    }

    fn unary(&mut self) -> AppResult<Expr> {
        if self.peek() == Some(&Tok::Minus) {
            self.pos += 1;
            self.enter()?;
            let operand = self.unary()?;
            self.depth -= 1;
            return Ok(Expr::Unary {
                op: UnaryOp::Neg,
                operand: Box::new(operand),
            });
        }
        self.primary()
    }

    fn primary(&mut self) -> AppResult<Expr> {
        let at = self.offset();
        match self.bump() {
            Some(Tok::Num(value)) => Ok(Expr::Number { value }),
            Some(Tok::Str(value)) => Ok(Expr::String { value }),
            Some(Tok::LParen) => {
                let e = self.expr()?;
                self.expect(Tok::RParen, "')'")?;
                Ok(e)
            }
            Some(Tok::Bracket(name)) => self.column(&name, at),
            Some(Tok::Ident(name)) => {
                if self.peek() == Some(&Tok::LParen) {
                    self.pos += 1;
                    return self.call(&name, at);
                }
                match name.to_ascii_uppercase().as_str() {
                    "TRUE" => Ok(Expr::Boolean { value: true }),
                    "FALSE" => Ok(Expr::Boolean { value: false }),
                    "NULL" => Ok(Expr::Null),
                    "AND" | "OR" | "NOT" => {
                        Err(AppError::expr(format!("unexpected keyword '{name}'"), at))
                    }
                    _ => self.column(&name, at),
                }
            }
            Some(_) => Err(AppError::expr("unexpected token", at)),
            None => Err(AppError::expr("unexpected end of expression", at)),
        }
    }

    fn column(&self, name: &str, at: usize) -> AppResult<Expr> {
        let name = name.trim();
        if let Some(c) = self.columns.iter().find(|c| c.name == name) {
            return Ok(Expr::Column {
                name: c.name.clone(),
            });
        }
        let ci: Vec<&ColumnInfo> = self
            .columns
            .iter()
            .filter(|c| c.name.eq_ignore_ascii_case(name))
            .collect();
        match ci.as_slice() {
            [one] => Ok(Expr::Column {
                name: one.name.clone(),
            }),
            [] => Err(AppError::expr(format!("unknown column '{name}'"), at)),
            _ => Err(AppError::expr(
                format!("ambiguous column '{name}', use exact case"),
                at,
            )),
        }
    }

    fn args(&mut self) -> AppResult<Vec<Expr>> {
        let mut args = Vec::new();
        if self.peek() == Some(&Tok::RParen) {
            self.pos += 1;
            return Ok(args);
        }
        loop {
            args.push(self.expr()?);
            if args.len() > MAX_ARGS {
                return Err(AppError::expr("too many arguments", self.offset()));
            }
            match self.bump() {
                Some(Tok::Comma) => continue,
                Some(Tok::RParen) => return Ok(args),
                _ => return Err(AppError::expr("expected ',' or ')'", self.offset())),
            }
        }
    }

    fn call(&mut self, name: &str, at: usize) -> AppResult<Expr> {
        let upper = name.to_ascii_uppercase();
        let agg = match upper.as_str() {
            "SUM" => Some(AggFunc::Sum),
            "AVG" => Some(AggFunc::Avg),
            "MIN" => Some(AggFunc::Min),
            "MAX" => Some(AggFunc::Max),
            "COUNT" => Some(AggFunc::Count),
            "COUNT_DISTINCT" => Some(AggFunc::CountDistinct),
            _ => None,
        };
        if let Some(func) = agg {
            if func == AggFunc::Count && self.peek() == Some(&Tok::Star) {
                self.pos += 1;
                self.expect(Tok::RParen, "')'")?;
                return Ok(Expr::Aggregate { func, arg: None });
            }
            let mut args = self.args()?;
            if args.len() != 1 {
                return Err(AppError::expr(format!("{upper} takes exactly one argument"), at));
            }
            return Ok(Expr::Aggregate {
                func,
                arg: Some(Box::new(args.remove(0))),
            });
        }
        let func = match upper.as_str() {
            "IF" => Func::If,
            "ROUND" => Func::Round,
            "ABS" => Func::Abs,
            "COALESCE" => Func::Coalesce,
            _ => {
                return Err(AppError::expr(
                    format!(
                        "unknown function '{name}'. Allowed: IF, ROUND, ABS, COALESCE, SUM, AVG, MIN, MAX, COUNT, COUNT_DISTINCT"
                    ),
                    at,
                ))
            }
        };
        let args = self.args()?;
        let ok = match func {
            Func::If => args.len() == 3,
            Func::Round => {
                (args.len() == 1 || args.len() == 2)
                    && args.get(1).is_none_or(|a| {
                        matches!(a, Expr::Number { value } if value.fract() == 0.0 && *value <= 15.0)
                    })
            }
            Func::Abs => args.len() == 1,
            Func::Coalesce => !args.is_empty(),
        };
        if !ok {
            let usage = match func {
                Func::If => "IF(condition, then, else)",
                Func::Round => "ROUND(value[, digits]) with an integer literal for digits",
                Func::Abs => "ABS(value)",
                Func::Coalesce => "COALESCE(value, ...)",
            };
            return Err(AppError::expr(format!("usage: {usage}"), at));
        }
        Ok(Expr::Call { func, args })
    }
}

fn bin(op: BinaryOp, left: Expr, right: Expr) -> Expr {
    Expr::Binary {
        op,
        left: Box::new(left),
        right: Box::new(right),
    }
}

// ---------------------------------------------------------------------------------------------
// Analysis

#[derive(Default)]
struct Analysis {
    has_aggregate: bool,
    bare_column: bool,
    columns: Vec<String>,
}

fn analyse(e: &Expr, inside_agg: bool, a: &mut Analysis) -> AppResult<()> {
    match e {
        Expr::Column { name } => {
            if !inside_agg {
                a.bare_column = true;
            }
            if !a.columns.contains(name) {
                a.columns.push(name.clone());
            }
        }
        Expr::Unary { operand, .. } => analyse(operand, inside_agg, a)?,
        Expr::Binary { left, right, .. } => {
            analyse(left, inside_agg, a)?;
            analyse(right, inside_agg, a)?;
        }
        Expr::Call { args, .. } => {
            for arg in args {
                analyse(arg, inside_agg, a)?;
            }
        }
        Expr::Aggregate { arg, .. } => {
            if inside_agg {
                return Err(AppError::expr("aggregates cannot be nested", 0));
            }
            a.has_aggregate = true;
            if let Some(arg) = arg {
                analyse(arg, true, a)?;
            }
        }
        Expr::Number { .. } | Expr::String { .. } | Expr::Boolean { .. } | Expr::Null => {}
    }
    Ok(())
}

pub fn parse(src: &str, columns: &[ColumnInfo]) -> AppResult<ParsedExpression> {
    if src.trim().is_empty() {
        return Err(AppError::expr("expression is empty", 0));
    }
    if src.len() > MAX_EXPRESSION_LEN {
        return Err(AppError::expr("expression is too long", MAX_EXPRESSION_LEN));
    }
    let toks = lex(src)?;
    let mut p = Parser {
        toks,
        pos: 0,
        end: src.len(),
        depth: 0,
        columns,
    };
    let ast = p.expr()?;
    if p.pos < p.toks.len() {
        return Err(AppError::expr("unexpected input after expression", p.offset()));
    }
    let mut a = Analysis::default();
    analyse(&ast, false, &mut a)?;
    if a.has_aggregate && a.bare_column {
        return Err(AppError::expr(
            "columns outside an aggregate cannot be mixed with aggregates; wrap them in SUM/AVG/MIN/MAX/COUNT",
            0,
        ));
    }
    Ok(ParsedExpression {
        ast,
        is_aggregate: a.has_aggregate,
        columns: a.columns,
    })
}

// ---------------------------------------------------------------------------------------------
// SQL compilation

fn number_sql(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        // `{:?}` always yields a valid numeric literal (e.g. 0.1, 1e300).
        format!("{v:?}")
    }
}

pub fn compile(e: &Expr, params: &mut Vec<SqlParam>) -> String {
    match e {
        Expr::Number { value } => number_sql(*value),
        Expr::String { value } => {
            params.push(SqlParam::Text(value.clone()));
            "?".into()
        }
        Expr::Boolean { value } => if *value { "TRUE" } else { "FALSE" }.into(),
        Expr::Null => "NULL".into(),
        Expr::Column { name } => quote_ident(name),
        Expr::Unary { op, operand } => {
            let inner = compile(operand, params);
            match op {
                UnaryOp::Neg => format!("(-{inner})"),
                UnaryOp::Not => format!("(NOT {inner})"),
            }
        }
        Expr::Binary { op, left, right } => {
            let l = compile(left, params);
            let r = compile(right, params);
            match op {
                BinaryOp::Div => format!("({l} / NULLIF({r}, 0))"),
                BinaryOp::Mod => format!("({l} % NULLIF({r}, 0))"),
                _ => {
                    let sym = match op {
                        BinaryOp::Add => "+",
                        BinaryOp::Sub => "-",
                        BinaryOp::Mul => "*",
                        BinaryOp::Eq => "=",
                        BinaryOp::Neq => "<>",
                        BinaryOp::Lt => "<",
                        BinaryOp::Lte => "<=",
                        BinaryOp::Gt => ">",
                        BinaryOp::Gte => ">=",
                        BinaryOp::And => "AND",
                        BinaryOp::Or => "OR",
                        BinaryOp::Div | BinaryOp::Mod => unreachable!(),
                    };
                    format!("({l} {sym} {r})")
                }
            }
        }
        Expr::Call { func, args } => {
            let a: Vec<String> = args.iter().map(|x| compile(x, params)).collect();
            match func {
                Func::If => format!("(CASE WHEN {} THEN {} ELSE {} END)", a[0], a[1], a[2]),
                Func::Round => format!("round({})", a.join(", ")),
                Func::Abs => format!("abs({})", a[0]),
                Func::Coalesce => format!("coalesce({})", a.join(", ")),
            }
        }
        Expr::Aggregate { func, arg } => {
            let inner = arg.as_ref().map(|x| compile(x, params));
            match (func, inner) {
                (AggFunc::Count, None) => "count(*)".into(),
                (AggFunc::CountDistinct, Some(i)) => format!("count(DISTINCT {i})"),
                (f, Some(i)) => {
                    let name = match f {
                        AggFunc::Sum => "sum",
                        AggFunc::Avg => "avg",
                        AggFunc::Min => "min",
                        AggFunc::Max => "max",
                        AggFunc::Count => "count",
                        AggFunc::CountDistinct => unreachable!(),
                    };
                    format!("{name}({i})")
                }
                (_, None) => "count(*)".into(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogicalType;

    fn cols() -> Vec<ColumnInfo> {
        ["revenue", "cost", "region", "Unit Price", "qty"]
            .iter()
            .map(|n| ColumnInfo {
                name: n.to_string(),
                logical_type: if *n == "region" {
                    LogicalType::String
                } else {
                    LogicalType::Float
                },
                duck_type: "DOUBLE".into(),
                null_count: 0,
                distinct_estimate: 0,
                original_type: None,
            })
            .collect()
    }

    fn sql(src: &str) -> (String, Vec<SqlParam>, bool) {
        let p = parse(src, &cols()).unwrap_or_else(|e| panic!("{src}: {e}"));
        let mut params = Vec::new();
        let s = compile(&p.ast, &mut params);
        (s, params, p.is_aggregate)
    }

    fn err(src: &str) -> String {
        match parse(src, &cols()) {
            Ok(p) => panic!("expected error for {src:?}, got {:?}", p.ast),
            Err(e) => e.to_string(),
        }
    }

    #[test]
    fn arithmetic_precedence() {
        assert_eq!(sql("revenue - cost * 2").0, "(\"revenue\" - (\"cost\" * 2))");
        assert_eq!(sql("(revenue - cost) * 2").0, "((\"revenue\" - \"cost\") * 2)");
        assert_eq!(sql("-revenue + 1.5").0, "((-\"revenue\") + 1.5)");
        assert_eq!(sql("revenue / qty").0, "(\"revenue\" / NULLIF(\"qty\", 0))");
        assert_eq!(sql("revenue % 3").0, "(\"revenue\" % NULLIF(3, 0))");
    }

    #[test]
    fn aggregates_and_functions() {
        let (s, _, agg) = sql("SUM(revenue) / COUNT(*)");
        assert!(agg);
        assert_eq!(s, "(sum(\"revenue\") / NULLIF(count(*), 0))");
        assert_eq!(
            sql("round(sum(revenue - cost) / sum(revenue) * 100, 1)").0,
            "round(((sum((\"revenue\" - \"cost\")) / NULLIF(sum(\"revenue\"), 0)) * 100), 1)"
        );
        assert_eq!(sql("count_distinct(region)").0, "count(DISTINCT \"region\")");
        assert_eq!(sql("ABS(cost)").0, "abs(\"cost\")");
        assert_eq!(sql("coalesce(cost, 0)").0, "coalesce(\"cost\", 0)");
        assert!(!sql("revenue * qty").2);
    }

    #[test]
    fn if_with_strings_binds_params() {
        let (s, params, _) = sql("IF(region = 'North', revenue, 0)");
        assert_eq!(s, "(CASE WHEN (\"region\" = ?) THEN \"revenue\" ELSE 0 END)");
        assert_eq!(params, vec![SqlParam::Text("North".into())]);
        let (s, _, _) = sql("IF(revenue > 10 AND NOT cost <= 5 OR qty <> 1, 1, 0)");
        assert_eq!(
            s,
            "(CASE WHEN (((\"revenue\" > 10) AND (NOT (\"cost\" <= 5))) OR (\"qty\" <> 1)) THEN 1 ELSE 0 END)"
        );
    }

    #[test]
    fn bracketed_and_case_insensitive_columns() {
        assert_eq!(sql("[Unit Price] * QTY").0, "(\"Unit Price\" * \"qty\")");
        assert_eq!(
            parse("[Unit Price]", &cols()).unwrap().columns,
            vec!["Unit Price".to_string()]
        );
    }

    #[test]
    fn numbers_are_reserialised() {
        assert_eq!(sql("1e3 + 0.25").0, "(1000 + 0.25)");
        assert_eq!(sql("1e300").0, "1e300");
    }

    #[test]
    fn ast_serialises_with_type_tags() {
        let p = parse("SUM(revenue)", &cols()).unwrap();
        let j = serde_json::to_value(&p.ast).unwrap();
        assert_eq!(j["type"], "aggregate");
        assert_eq!(j["func"], "sum");
        assert_eq!(j["arg"]["type"], "column");
        assert_eq!(j["arg"]["name"], "revenue");
    }

    #[test]
    fn rejects_invalid_expressions() {
        assert!(err("").contains("empty"));
        assert!(err("revenue +").contains("unexpected end"));
        assert!(err("unknown_col * 2").contains("unknown column"));
        assert!(err("SUM(SUM(revenue))").contains("nested"));
        assert!(err("SUM(revenue) + cost").contains("cannot be mixed"));
        assert!(err("IF(revenue > 1, 2)").contains("usage"));
        assert!(err("ROUND(revenue, qty)").contains("usage"));
        assert!(err("'abc").contains("unterminated"));
        assert!(err("revenue revenue").contains("unexpected input"));
        assert!(err(&"(".repeat(100)).contains("nested too deeply"));
        assert!(err(&"1+".repeat(1500)).contains("too long"));
    }

    #[test]
    fn rejects_sql_injection_attempts() {
        assert!(err("revenue); DROP TABLE ds_x; --").contains("unexpected"));
        assert!(err("revenue; DELETE FROM x").contains("unexpected character ';'"));
        assert!(err("read_csv('/etc/passwd')").contains("unknown function"));
        assert!(err("current_setting('x')").contains("unknown function"));
        assert!(err("[revenue\"; DROP TABLE x; --]").contains("unknown column"));
        assert!(err("revenue -- comment").contains("unknown column 'comment'"));
        assert!(err("revenue /* c */").contains("unexpected"));
        assert!(err("SELECT 1").contains("unknown column"));
        // Quotes inside strings become bound parameters, not SQL.
        let (s, params, _) = sql("IF(region = 'x'' OR 1=1 --', 1, 0)");
        assert!(!s.contains("OR 1=1"));
        assert_eq!(params, vec![SqlParam::Text("x' OR 1=1 --".into())]);
    }
}
