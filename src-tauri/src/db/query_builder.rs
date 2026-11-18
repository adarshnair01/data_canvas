//! `QuerySpec` -> parameterised SQL.
//!
//! Every identifier is validated against the dataset schema and quoted; every user value is bound
//! as a parameter. Results are capped at [`CHART_ROW_CAP`].

use std::collections::HashSet;
use std::time::Instant;

use chrono::NaiveDate;
use duckdb::types::Value;
use duckdb::{params_from_iter, Connection};
use serde::Serialize;
use serde_json::Value as Json;

use crate::db::expr;
use crate::db::ident::{quote_ident, validate_alias, view_name};
use crate::db::spec::{Aggregation, Dimension, Filter, Measure, MeasureSource, QueryMode, QuerySpec};
use crate::db::values::to_json;
use crate::error::{AppError, AppResult};
use crate::model::{ColumnInfo, LogicalType};

pub const CHART_ROW_CAP: u32 = 5000;
const MAX_IN_VALUES: usize = 1000;
const MAX_OFFSET: u32 = 100_000_000;

#[derive(Debug, Clone, PartialEq)]
pub enum SqlParam {
    Text(String),
    Int(i64),
    Float(f64),
    Bool(bool),
}

impl SqlParam {
    pub(crate) fn to_value(&self) -> Value {
        match self {
            SqlParam::Text(s) => Value::Text(s.clone()),
            SqlParam::Int(i) => Value::BigInt(*i),
            SqlParam::Float(f) => Value::Double(*f),
            SqlParam::Bool(b) => Value::Boolean(*b),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnRole {
    Dimension,
    Measure,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputColumn {
    pub id: String,
    pub role: ColumnRole,
}

#[derive(Debug, Clone)]
pub struct BuiltQuery {
    pub sql: String,
    pub params: Vec<SqlParam>,
    pub columns: Vec<OutputColumn>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<OutputColumn>,
    pub rows: Vec<Vec<Json>>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

fn find_column<'a>(schema: &'a [ColumnInfo], field: &str) -> AppResult<&'a ColumnInfo> {
    schema
        .iter()
        .find(|c| c.name == field)
        .ok_or_else(|| AppError::UnknownColumn(field.to_string()))
}

fn dimension_sql(d: &Dimension, schema: &[ColumnInfo]) -> AppResult<String> {
    let col = find_column(schema, &d.field)?;
    let q = quote_ident(&col.name);
    match d.bucket {
        None => Ok(q),
        Some(b) => {
            if !col.logical_type.is_temporal() {
                return Err(AppError::query(format!(
                    "date bucketing requires a date column, '{}' is {:?}",
                    col.name, col.logical_type
                )));
            }
            Ok(format!("CAST(date_trunc('{}', {q}) AS DATE)", b.sql_part()))
        }
    }
}

fn agg_sql(agg: Aggregation, inner: &str) -> String {
    match agg {
        Aggregation::Sum => format!("sum({inner})"),
        Aggregation::Avg => format!("avg({inner})"),
        Aggregation::Count => format!("count({inner})"),
        Aggregation::CountDistinct => format!("count(DISTINCT {inner})"),
        Aggregation::Min => format!("min({inner})"),
        Aggregation::Max => format!("max({inner})"),
        Aggregation::None => inner.to_string(),
    }
}

fn measure_sql(
    m: &Measure,
    mode: QueryMode,
    schema: &[ColumnInfo],
    params: &mut Vec<SqlParam>,
) -> AppResult<String> {
    match (&m.source, mode) {
        (MeasureSource::Rows, QueryMode::Aggregate) => Ok("count(*)".into()),
        (MeasureSource::Rows, QueryMode::Raw) => {
            Err(AppError::query("row count measures require aggregate mode"))
        }
        (MeasureSource::Column { column }, _) => {
            let col = find_column(schema, column)?;
            let q = quote_ident(&col.name);
            match (mode, m.agg) {
                (QueryMode::Aggregate, Aggregation::None) => Err(AppError::query(format!(
                    "measure '{}' needs an aggregation",
                    col.name
                ))),
                (QueryMode::Raw, Aggregation::None) => Ok(q),
                (QueryMode::Raw, _) => Err(AppError::query(
                    "aggregations are not allowed in raw mode",
                )),
                (QueryMode::Aggregate, Aggregation::Sum | Aggregation::Avg)
                    if !col.logical_type.is_numeric() =>
                {
                    Err(AppError::query(format!(
                        "cannot {:?} non-numeric column '{}'",
                        m.agg, col.name
                    )))
                }
                (QueryMode::Aggregate, agg) => Ok(agg_sql(agg, &q)),
            }
        }
        (MeasureSource::Expression { expression }, _) => {
            let parsed = expr::parse(expression, schema)?;
            let sql = expr::compile(&parsed.ast, params);
            match (mode, parsed.is_aggregate, m.agg) {
                (QueryMode::Aggregate, true, Aggregation::None) => Ok(sql),
                (_, true, _) if mode == QueryMode::Raw => Err(AppError::query(
                    "aggregate expressions are not allowed in raw mode",
                )),
                (_, true, _) => Err(AppError::query(
                    "expression already aggregates; set aggregation to none",
                )),
                (QueryMode::Aggregate, false, Aggregation::None) => Err(AppError::query(
                    "row-level expression needs an aggregation",
                )),
                (QueryMode::Aggregate, false, agg) => Ok(agg_sql(agg, &sql)),
                (QueryMode::Raw, false, Aggregation::None) => Ok(sql),
                (QueryMode::Raw, false, _) => Err(AppError::query(
                    "aggregations are not allowed in raw mode",
                )),
            }
        }
    }
}

fn json_param(v: &Json, col: &ColumnInfo) -> AppResult<SqlParam> {
    let t = col.logical_type;
    let bad = || AppError::query(format!("invalid filter value {v} for column '{}'", col.name));
    Ok(match (t, v) {
        (LogicalType::Integer | LogicalType::Float, Json::Number(n)) => match n.as_i64() {
            Some(i) => SqlParam::Int(i),
            None => SqlParam::Float(n.as_f64().ok_or_else(bad)?),
        },
        (LogicalType::Integer | LogicalType::Float, Json::String(s)) => match s.trim().parse::<i64>() {
            Ok(i) => SqlParam::Int(i),
            Err(_) => SqlParam::Float(s.trim().parse::<f64>().map_err(|_| bad())?),
        },
        (LogicalType::Boolean, Json::Bool(b)) => SqlParam::Bool(*b),
        (LogicalType::Boolean, Json::String(s)) => match s.as_str() {
            "true" => SqlParam::Bool(true),
            "false" => SqlParam::Bool(false),
            _ => return Err(bad()),
        },
        (_, Json::String(s)) => SqlParam::Text(s.clone()),
        (_, Json::Number(n)) => SqlParam::Text(n.to_string()),
        (_, Json::Bool(b)) => SqlParam::Text(b.to_string()),
        _ => return Err(bad()),
    })
}

fn parse_date(s: &str) -> AppResult<String> {
    let d = s.get(..10).unwrap_or(s);
    NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .map(|d| d.format("%Y-%m-%d").to_string())
        .map_err(|_| AppError::query(format!("invalid date '{s}', expected YYYY-MM-DD")))
}

fn filter_sql(
    f: &Filter,
    schema: &[ColumnInfo],
    params: &mut Vec<SqlParam>,
) -> AppResult<Option<String>> {
    match f {
        Filter::In {
            field,
            values,
            exclude,
        } => {
            let col = find_column(schema, field)?;
            if values.is_empty() {
                return Ok(None);
            }
            if values.len() > MAX_IN_VALUES {
                return Err(AppError::query("too many filter values"));
            }
            // Temporal values arrive as the strings we produced, so compare as text.
            let target = if col.logical_type.is_temporal() || col.logical_type == LogicalType::Other {
                format!("CAST({} AS VARCHAR)", quote_ident(&col.name))
            } else {
                quote_ident(&col.name)
            };
            let has_null = values.iter().any(Json::is_null);
            let mut placeholders = Vec::new();
            for v in values.iter().filter(|v| !v.is_null()) {
                let p = if col.logical_type.is_temporal() || col.logical_type == LogicalType::Other {
                    match v {
                        Json::String(s) => SqlParam::Text(s.clone()),
                        other => SqlParam::Text(other.to_string()),
                    }
                } else {
                    json_param(v, col)?
                };
                params.push(p);
                placeholders.push("?");
            }
            let q = quote_ident(&col.name);
            let mut parts = Vec::new();
            if !placeholders.is_empty() {
                parts.push(format!("{target} IN ({})", placeholders.join(", ")));
            }
            if has_null {
                parts.push(format!("{q} IS NULL"));
            }
            let cond = format!("({})", parts.join(" OR "));
            Ok(Some(if *exclude {
                // NULLs should survive an exclusion unless explicitly excluded.
                if has_null {
                    format!("(NOT {cond})")
                } else {
                    format!("(NOT {cond} OR {q} IS NULL)")
                }
            } else {
                cond
            }))
        }
        Filter::Range { field, min, max } => {
            let col = find_column(schema, field)?;
            if !col.logical_type.is_numeric() {
                return Err(AppError::query(format!(
                    "numeric range filter on non-numeric column '{}'",
                    col.name
                )));
            }
            let q = quote_ident(&col.name);
            let mut parts = Vec::new();
            for (bound, op) in [(min, ">="), (max, "<=")] {
                if let Some(v) = bound {
                    if !v.is_finite() {
                        return Err(AppError::query("range bounds must be finite"));
                    }
                    params.push(SqlParam::Float(*v));
                    parts.push(format!("{q} {op} ?"));
                }
            }
            Ok((!parts.is_empty()).then(|| format!("({})", parts.join(" AND "))))
        }
        Filter::DateRange { field, from, to } => {
            let col = find_column(schema, field)?;
            if !col.logical_type.is_temporal() {
                return Err(AppError::query(format!(
                    "date range filter on non-date column '{}'",
                    col.name
                )));
            }
            let q = quote_ident(&col.name);
            let mut parts = Vec::new();
            if let Some(from) = from.as_deref().filter(|s| !s.is_empty()) {
                params.push(SqlParam::Text(parse_date(from)?));
                parts.push(format!("{q} >= CAST(? AS DATE)"));
            }
            if let Some(to) = to.as_deref().filter(|s| !s.is_empty()) {
                params.push(SqlParam::Text(parse_date(to)?));
                parts.push(format!("{q} < CAST(? AS DATE) + INTERVAL 1 DAY"));
            }
            Ok((!parts.is_empty()).then(|| format!("({})", parts.join(" AND "))))
        }
        Filter::Contains { field, text } => {
            let col = find_column(schema, field)?;
            if text.is_empty() {
                return Ok(None);
            }
            params.push(SqlParam::Text(text.clone()));
            Ok(Some(format!(
                "contains(lower(CAST({} AS VARCHAR)), lower(?))",
                quote_ident(&col.name)
            )))
        }
    }
}

pub fn build_query(spec: &QuerySpec, schema: &[ColumnInfo]) -> AppResult<BuiltQuery> {
    build(spec, schema, Some(CHART_ROW_CAP))
}

/// Same validation as [`build_query`] but without the chart row cap, for CSV export.
/// An explicit `spec.limit` (top-N, KPI) is still honoured.
pub fn build_export_query(spec: &QuerySpec, schema: &[ColumnInfo]) -> AppResult<BuiltQuery> {
    build(spec, schema, None)
}

fn build(spec: &QuerySpec, schema: &[ColumnInfo], cap: Option<u32>) -> AppResult<BuiltQuery> {
    let relation = quote_ident(&view_name(&spec.dataset_id)?);
    if spec.dimensions.is_empty() && spec.measures.is_empty() {
        return Err(AppError::query("select at least one field"));
    }

    let mut ids = HashSet::new();
    let mut columns = Vec::new();
    let mut select = Vec::new();
    let mut group_by = Vec::new();
    let mut params = Vec::new();

    for d in &spec.dimensions {
        validate_alias(&d.id)?;
        if !ids.insert(d.id.as_str()) {
            return Err(AppError::query(format!("duplicate id '{}'", d.id)));
        }
        let sql = dimension_sql(d, schema)?;
        select.push(format!("{sql} AS {}", quote_ident(&d.id)));
        group_by.push(sql);
        columns.push(OutputColumn {
            id: d.id.clone(),
            role: ColumnRole::Dimension,
        });
    }
    for m in &spec.measures {
        validate_alias(&m.id)?;
        if !ids.insert(m.id.as_str()) {
            return Err(AppError::query(format!("duplicate id '{}'", m.id)));
        }
        let sql = measure_sql(m, spec.mode, schema, &mut params)?;
        select.push(format!("{sql} AS {}", quote_ident(&m.id)));
        columns.push(OutputColumn {
            id: m.id.clone(),
            role: ColumnRole::Measure,
        });
    }

    let mut wheres = Vec::new();
    for f in &spec.filters {
        if let Some(w) = filter_sql(f, schema, &mut params)? {
            wheres.push(w);
        }
    }

    let mut order = Vec::new();
    for s in &spec.sort {
        if !ids.contains(s.by.as_str()) {
            return Err(AppError::query(format!("sort references unknown id '{}'", s.by)));
        }
        order.push(format!("{} {} NULLS LAST", quote_ident(&s.by), s.dir.sql()));
    }
    if order.is_empty() {
        if let Some(d) = spec.dimensions.iter().find(|d| d.bucket.is_some()) {
            order.push(format!("{} ASC NULLS LAST", quote_ident(&d.id)));
        }
    }

    let offset = spec.offset.unwrap_or(0).min(MAX_OFFSET);

    let mut sql = format!("SELECT {} FROM {relation}", select.join(", "));
    if !wheres.is_empty() {
        sql.push_str(&format!(" WHERE {}", wheres.join(" AND ")));
    }
    if spec.mode == QueryMode::Aggregate && !group_by.is_empty() {
        sql.push_str(&format!(" GROUP BY {}", group_by.join(", ")));
    }
    if !order.is_empty() {
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    let limit = match cap {
        Some(cap) => {
            let limit = spec.limit.unwrap_or(cap).clamp(1, cap);
            // Fetch one extra row to detect truncation.
            sql.push_str(&format!(" LIMIT {} OFFSET {offset}", limit + 1));
            limit
        }
        None => {
            if let Some(l) = spec.limit {
                sql.push_str(&format!(" LIMIT {}", l.max(1)));
            }
            if offset > 0 {
                sql.push_str(&format!(" OFFSET {offset}"));
            }
            spec.limit.map_or(u32::MAX, |l| l.max(1))
        }
    };

    Ok(BuiltQuery {
        sql,
        params,
        columns,
        limit,
    })
}

pub fn execute(conn: &Connection, q: &BuiltQuery) -> AppResult<QueryResult> {
    let started = Instant::now();
    let values: Vec<Value> = q.params.iter().map(SqlParam::to_value).collect();
    let mut stmt = conn.prepare(&q.sql)?;
    let width = q.columns.len();
    let mut rows = stmt
        .query_map(params_from_iter(values.iter()), |r| {
            (0..width).map(|i| r.get::<_, Value>(i).map(to_json)).collect()
        })?
        .collect::<Result<Vec<Vec<Json>>, _>>()?;
    let truncated = rows.len() > q.limit as usize;
    rows.truncate(q.limit as usize);
    Ok(QueryResult {
        columns: q.columns.clone(),
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{create_view, detect_schema, SortDir};
    use crate::db::spec::{DateBucket, SortSpec};
    use serde_json::json;
    use std::collections::BTreeMap;

    const DS: &str = "t1";

    fn setup() -> (Connection, Vec<ColumnInfo>) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE ds_t1 (region VARCHAR, product VARCHAR, order_date DATE, revenue DOUBLE, qty BIGINT, \"we\"\"ird col\" VARCHAR);
             INSERT INTO ds_t1 VALUES
               ('North', 'A', DATE '2024-01-05', 100.0, 2, 'x'),
               ('North', 'B', DATE '2024-01-20', 50.0, 1, 'y'),
               ('South', 'A', DATE '2024-02-03', 80.0, 4, 'x'),
               ('South', 'C', DATE '2024-03-15', 20.0, 1, NULL),
               ('East',  'B', DATE '2024-03-30', 60.0, 3, 'z'),
               (NULL,    'A', DATE '2024-04-01', 10.0, 1, 'x');",
        )
        .unwrap();
        create_view(&conn, DS, &BTreeMap::new()).unwrap();
        let (cols, rows) = detect_schema(&conn, DS, &BTreeMap::new()).unwrap();
        assert_eq!(rows, 6);
        (conn, cols)
    }

    fn spec(v: serde_json::Value) -> QuerySpec {
        serde_json::from_value(v).unwrap()
    }

    fn run(conn: &Connection, cols: &[ColumnInfo], s: &QuerySpec) -> QueryResult {
        let q = build_query(s, cols).unwrap_or_else(|e| panic!("build: {e}"));
        execute(conn, &q).unwrap_or_else(|e| panic!("execute {}: {e}", q.sql))
    }

    fn sum_by(dim: serde_json::Value) -> serde_json::Value {
        json!({
            "datasetId": DS,
            "dimensions": [dim],
            "measures": [{"id": "m0", "source": {"type": "column", "column": "revenue"}, "agg": "sum"}],
            "sort": [{"by": "d0", "dir": "asc"}]
        })
    }

    #[test]
    fn bar_chart_groups_and_sums() {
        let (conn, cols) = setup();
        let s = spec(sum_by(json!({"id": "d0", "field": "region"})));
        let q = build_query(&s, &cols).unwrap();
        assert_eq!(
            q.sql,
            "SELECT \"region\" AS \"d0\", sum(\"revenue\") AS \"m0\" FROM \"dsv_t1\" GROUP BY \"region\" ORDER BY \"d0\" ASC NULLS LAST LIMIT 5001 OFFSET 0"
        );
        let r = execute(&conn, &q).unwrap();
        assert_eq!(
            r.rows,
            vec![
                vec![json!("East"), json!(60.0)],
                vec![json!("North"), json!(150.0)],
                vec![json!("South"), json!(100.0)],
                vec![json!(null), json!(10.0)],
            ]
        );
        assert!(!r.truncated);
    }

    #[test]
    fn line_and_area_charts_bucket_dates() {
        let (conn, cols) = setup();
        for bucket in ["day", "week", "month", "quarter", "year"] {
            let s = spec(sum_by(json!({"id": "d0", "field": "order_date", "bucket": bucket})));
            let r = run(&conn, &cols, &s);
            assert!(!r.rows.is_empty(), "{bucket}");
        }
        let s = spec(sum_by(json!({"id": "d0", "field": "order_date", "bucket": "month"})));
        let q = build_query(&s, &cols).unwrap();
        assert!(q.sql.contains("CAST(date_trunc('month', \"order_date\") AS DATE) AS \"d0\""));
        let r = execute(&conn, &q).unwrap();
        assert_eq!(r.rows[0], vec![json!("2024-01-01"), json!(150.0)]);
        assert_eq!(r.rows.len(), 4);
        let s = spec(sum_by(json!({"id": "d0", "field": "order_date", "bucket": "quarter"})));
        assert_eq!(run(&conn, &cols, &s).rows.len(), 2);
    }

    #[test]
    fn stacked_series_with_color_dimension() {
        let (conn, cols) = setup();
        let s = spec(json!({
            "datasetId": DS,
            "dimensions": [{"id": "x", "field": "region"}, {"id": "c", "field": "product"}],
            "measures": [{"id": "y", "source": {"type": "rows"}, "agg": "count"}],
            "filters": [{"kind": "in", "field": "region", "values": ["North", "South"]}],
            "sort": [{"by": "x", "dir": "asc"}, {"by": "c", "dir": "asc"}]
        }));
        let r = run(&conn, &cols, &s);
        assert_eq!(r.rows.len(), 4);
        assert_eq!(r.rows[0], vec![json!("North"), json!("A"), json!(1)]);
    }

    #[test]
    fn pie_chart_counts_distinct() {
        let (conn, cols) = setup();
        let s = spec(json!({
            "datasetId": DS,
            "dimensions": [{"id": "d0", "field": "product"}],
            "measures": [{"id": "m0", "source": {"type": "column", "column": "region"}, "agg": "count_distinct"}],
            "sort": [{"by": "m0", "dir": "desc"}, {"by": "d0", "dir": "asc"}]
        }));
        let r = run(&conn, &cols, &s);
        assert_eq!(r.rows[0], vec![json!("A"), json!(2)]);
    }

    #[test]
    fn scatter_uses_raw_mode() {
        let (conn, cols) = setup();
        let s = spec(json!({
            "datasetId": DS,
            "mode": "raw",
            "dimensions": [{"id": "color", "field": "region"}],
            "measures": [
                {"id": "x", "source": {"type": "column", "column": "qty"}, "agg": "none"},
                {"id": "y", "source": {"type": "column", "column": "revenue"}, "agg": "none"},
                {"id": "size", "source": {"type": "expression", "expression": "revenue / qty"}, "agg": "none"}
            ]
        }));
        let q = build_query(&s, &cols).unwrap();
        assert!(!q.sql.contains("GROUP BY"));
        let r = execute(&conn, &q).unwrap();
        assert_eq!(r.rows.len(), 6);
        assert_eq!(r.columns.len(), 4);
        // Aggregations are rejected in raw mode.
        let bad = spec(json!({
            "datasetId": DS, "mode": "raw",
            "measures": [{"id": "x", "source": {"type": "column", "column": "qty"}, "agg": "sum"}]
        }));
        assert!(build_query(&bad, &cols).is_err());
    }

    #[test]
    fn kpi_has_no_group_by() {
        let (conn, cols) = setup();
        let s = spec(json!({
            "datasetId": DS,
            "measures": [
                {"id": "total", "source": {"type": "column", "column": "revenue"}, "agg": "sum"},
                {"id": "margin", "source": {"type": "expression", "expression": "ROUND(SUM(revenue) / COUNT(*), 2)"}, "agg": "none"},
                {"id": "avg_qty", "source": {"type": "column", "column": "qty"}, "agg": "avg"},
                {"id": "mn", "source": {"type": "column", "column": "order_date"}, "agg": "min"},
                {"id": "mx", "source": {"type": "column", "column": "revenue"}, "agg": "max"}
            ]
        }));
        let q = build_query(&s, &cols).unwrap();
        assert!(!q.sql.contains("GROUP BY"));
        let r = execute(&conn, &q).unwrap();
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0][0], json!(320.0));
        assert_eq!(r.rows[0][1], json!(53.33));
        assert_eq!(r.rows[0][3], json!("2024-01-05"));
        assert_eq!(r.rows[0][4], json!(100.0));
    }

    #[test]
    fn table_supports_raw_paging_and_aggregate() {
        let (conn, cols) = setup();
        let s = spec(json!({
            "datasetId": DS,
            "mode": "raw",
            "dimensions": [{"id": "a", "field": "product"}, {"id": "b", "field": "we\"ird col"}],
            "measures": [{"id": "c", "source": {"type": "column", "column": "revenue"}, "agg": "none"}],
            "sort": [{"by": "c", "dir": "desc"}],
            "limit": 2,
            "offset": 1
        }));
        let q = build_query(&s, &cols).unwrap();
        assert!(q.sql.contains("\"we\"\"ird col\" AS \"b\""));
        let r = execute(&conn, &q).unwrap();
        assert_eq!(r.rows.len(), 2);
        assert!(r.truncated);
        assert_eq!(r.rows[0][2], json!(80.0));
        let agg = spec(json!({
            "datasetId": DS,
            "dimensions": [{"id": "a", "field": "product"}],
            "measures": [{"id": "c", "source": {"type": "expression", "expression": "revenue * qty"}, "agg": "sum"}],
            "sort": [{"by": "a", "dir": "asc"}]
        }));
        let r = run(&conn, &cols, &agg);
        assert_eq!(r.rows[0], vec![json!("A"), json!(530.0)]);
    }

    #[test]
    fn filters_bind_parameters() {
        let (conn, cols) = setup();
        let s = spec(json!({
            "datasetId": DS,
            "measures": [{"id": "n", "source": {"type": "rows"}, "agg": "count"}],
            "filters": [
                {"kind": "range", "field": "revenue", "min": 20, "max": 100},
                {"kind": "dateRange", "field": "order_date", "from": "2024-01-10", "to": "2024-03-15"},
                {"kind": "contains", "field": "product", "text": "a"},
                {"kind": "in", "field": "region", "values": ["South", null]},
                {"kind": "in", "field": "qty", "values": []}
            ]
        }));
        let q = build_query(&s, &cols).unwrap();
        assert_eq!(q.params.len(), 6);
        assert!(!q.sql.contains("South"));
        let r = execute(&conn, &q).unwrap();
        assert_eq!(r.rows[0][0], json!(1));
        let excl = spec(json!({
            "datasetId": DS,
            "measures": [{"id": "n", "source": {"type": "rows"}, "agg": "count"}],
            "filters": [{"kind": "in", "field": "region", "values": ["North"], "exclude": true}]
        }));
        assert_eq!(run(&conn, &cols, &excl).rows[0][0], json!(4));
        let dates = spec(json!({
            "datasetId": DS,
            "measures": [{"id": "n", "source": {"type": "rows"}, "agg": "count"}],
            "filters": [{"kind": "in", "field": "order_date", "values": ["2024-01-05", "2024-04-01"]}]
        }));
        assert_eq!(run(&conn, &cols, &dates).rows[0][0], json!(2));
    }

    #[test]
    fn caps_rows_and_reports_truncation() {
        let (conn, _) = setup();
        conn.execute_batch(
            "CREATE TABLE ds_big AS SELECT range AS i, range % 7 AS g FROM range(12000);",
        )
        .unwrap();
        create_view(&conn, "big", &BTreeMap::new()).unwrap();
        let (cols, _) = detect_schema(&conn, "big", &BTreeMap::new()).unwrap();
        let s = spec(json!({
            "datasetId": "big", "mode": "raw",
            "dimensions": [{"id": "i", "field": "i"}],
            "limit": 999999
        }));
        let r = run(&conn, &cols, &s);
        assert_eq!(r.rows.len(), CHART_ROW_CAP as usize);
        assert!(r.truncated);
    }

    #[test]
    fn validates_types_and_shapes() {
        let (_, cols) = setup();
        let cases = [
            json!({"datasetId": DS}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region", "bucket": "month"}]}),
            json!({"datasetId": DS, "measures": [{"id": "m", "source": {"type": "column", "column": "region"}, "agg": "sum"}]}),
            json!({"datasetId": DS, "measures": [{"id": "m", "source": {"type": "column", "column": "revenue"}, "agg": "none"}]}),
            json!({"datasetId": DS, "measures": [{"id": "m", "source": {"type": "expression", "expression": "SUM(revenue)"}, "agg": "sum"}]}),
            json!({"datasetId": DS, "measures": [{"id": "m", "source": {"type": "expression", "expression": "revenue"}, "agg": "none"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}, {"id": "d", "field": "product"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "sort": [{"by": "zzz", "dir": "asc"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "filters": [{"kind": "range", "field": "region", "min": 1}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "filters": [{"kind": "dateRange", "field": "revenue", "from": "2024-01-01"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "filters": [{"kind": "dateRange", "field": "order_date", "from": "yesterday"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "filters": [{"kind": "in", "field": "qty", "values": ["abc"]}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "filters": [{"kind": "in", "field": "region", "values": [{"a": 1}]}]}),
            json!({"datasetId": DS, "mode": "raw", "measures": [{"id": "m", "source": {"type": "rows"}, "agg": "count"}]}),
        ];
        for c in cases {
            let s = spec(c.clone());
            assert!(build_query(&s, &cols).is_err(), "expected error for {c}");
        }
    }

    #[test]
    fn rejects_injection_attempts() {
        let (conn, cols) = setup();
        let attacks = [
            // Unknown or crafted column names.
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region\"; DROP TABLE ds_t1; --"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "1); DROP TABLE ds_t1; --"}]}),
            json!({"datasetId": DS, "measures": [{"id": "m", "source": {"type": "column", "column": "*"}, "agg": "count"}]}),
            // Crafted aliases.
            json!({"datasetId": DS, "dimensions": [{"id": "d\" FROM ds_t1; DROP TABLE ds_t1; --", "field": "region"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "sort": [{"by": "d\"; DROP TABLE ds_t1; --", "dir": "asc"}]}),
            // Crafted dataset ids.
            json!({"datasetId": "t1\"; DROP TABLE ds_t1; --", "dimensions": [{"id": "d", "field": "region"}]}),
            json!({"datasetId": "../t1", "dimensions": [{"id": "d", "field": "region"}]}),
            // Expressions smuggling SQL.
            json!({"datasetId": DS, "measures": [{"id": "m", "source": {"type": "expression", "expression": "SUM(revenue)); DROP TABLE ds_t1; --"}, "agg": "none"}]}),
            json!({"datasetId": DS, "measures": [{"id": "m", "source": {"type": "expression", "expression": "read_csv_auto('/etc/passwd')"}, "agg": "none"}]}),
            // Filters on crafted fields.
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "filters": [{"kind": "contains", "field": "region) OR 1=1 --", "text": "x"}]}),
        ];
        for a in attacks {
            let s: QuerySpec = serde_json::from_value(a.clone()).unwrap();
            assert!(build_query(&s, &cols).is_err(), "expected rejection for {a}");
        }
        // Unknown enum values never deserialize (aggregations, buckets, sort directions).
        for bad in [
            json!({"datasetId": DS, "measures": [{"id": "m", "source": {"type": "column", "column": "revenue"}, "agg": "sum(revenue)); DROP TABLE ds_t1; --"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "order_date", "bucket": "month', x) --"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "sort": [{"by": "d", "dir": "asc; DROP TABLE ds_t1"}]}),
            json!({"datasetId": DS, "dimensions": [{"id": "d", "field": "region"}], "filters": [{"kind": "raw", "sql": "1=1"}]}),
        ] {
            assert!(serde_json::from_value::<QuerySpec>(bad.clone()).is_err(), "{bad}");
        }
        // Values are bound, so hostile strings are just data.
        let hostile = "North' OR '1'='1'; DROP TABLE ds_t1; --";
        let s = spec(json!({
            "datasetId": DS,
            "measures": [{"id": "n", "source": {"type": "rows"}, "agg": "count"}],
            "filters": [
                {"kind": "in", "field": "region", "values": [hostile]},
                {"kind": "contains", "field": "product", "text": "'); DROP TABLE ds_t1; --"}
            ]
        }));
        let q = build_query(&s, &cols).unwrap();
        assert!(!q.sql.contains("DROP"));
        let r = execute(&conn, &q).unwrap();
        assert_eq!(r.rows[0][0], json!(0));
        let still_there: i64 = conn
            .query_row("SELECT count(*) FROM ds_t1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, 6);
        // Hostile but quoted column names that exist are handled safely.
        let weird = spec(json!({
            "datasetId": DS,
            "dimensions": [{"id": "w", "field": "we\"ird col"}],
            "measures": [{"id": "n", "source": {"type": "rows"}, "agg": "count"}],
            "sort": [{"by": "w", "dir": "asc"}]
        }));
        assert_eq!(run(&conn, &cols, &weird).rows.len(), 4);
    }

    #[test]
    fn sort_spec_roundtrips() {
        let s = SortSpec {
            by: "a".into(),
            dir: SortDir::Desc,
        };
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j, json!({"by": "a", "dir": "desc"}));
        let b: DateBucket = serde_json::from_value(json!("quarter")).unwrap();
        assert_eq!(b.sql_part(), "quarter");
    }
}
