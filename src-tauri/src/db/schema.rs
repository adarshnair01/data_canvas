//! Schema detection, type overrides (as a casting view), paged preview and per-column stats.

use std::collections::BTreeMap;

use duckdb::types::Value;
use duckdb::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::db::ident::{quote_ident, table_name, view_name};
use crate::db::values::to_json;
use crate::error::{AppError, AppResult};
use crate::model::{ColumnInfo, LogicalType};

pub const PREVIEW_PAGE_CAP: u32 = 1000;
pub const DISTINCT_CAP: u32 = 500;

/// Raw (name, duck type) pairs of a relation.
pub fn describe(conn: &Connection, relation: &str) -> AppResult<Vec<(String, String)>> {
    let sql = format!("DESCRIBE SELECT * FROM {}", quote_ident(relation));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// (Re)create the query view for a dataset, applying `TRY_CAST` for overridden columns.
pub fn create_view(
    conn: &Connection,
    dataset_id: &str,
    overrides: &BTreeMap<String, LogicalType>,
) -> AppResult<()> {
    let table = table_name(dataset_id)?;
    let view = view_name(dataset_id)?;
    let base = describe(conn, &table)?;
    for name in overrides.keys() {
        if !base.iter().any(|(n, _)| n == name) {
            return Err(AppError::UnknownColumn(name.clone()));
        }
    }
    let select = base
        .iter()
        .map(|(name, _)| {
            let q = quote_ident(name);
            match overrides.get(name).and_then(|t| t.cast_target()) {
                Some(target) => format!("TRY_CAST({q} AS {target}) AS {q}"),
                None => q,
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute_batch(&format!(
        "CREATE OR REPLACE VIEW {} AS SELECT {select} FROM {}",
        quote_ident(&view),
        quote_ident(&table)
    ))?;
    Ok(())
}

/// Detect columns of the dataset view with null counts and distinct estimates.
pub fn detect_schema(
    conn: &Connection,
    dataset_id: &str,
    overrides: &BTreeMap<String, LogicalType>,
) -> AppResult<(Vec<ColumnInfo>, i64)> {
    let table = table_name(dataset_id)?;
    let view = view_name(dataset_id)?;
    let original: BTreeMap<String, String> = describe(conn, &table)?.into_iter().collect();
    let cols = describe(conn, &view)?;
    if cols.is_empty() {
        return Err(AppError::EmptyFile);
    }
    let mut exprs = vec!["count(*)".to_string()];
    for (name, _) in &cols {
        let q = quote_ident(name);
        exprs.push(format!("count(*) - count({q})"));
        exprs.push(format!("approx_count_distinct({q})"));
    }
    let sql = format!("SELECT {} FROM {}", exprs.join(", "), quote_ident(&view));
    let stats: Vec<i64> = conn.query_row(&sql, [], |r| {
        (0..exprs.len()).map(|i| r.get::<_, i64>(i)).collect()
    })?;
    let row_count = stats[0];
    let columns = cols
        .into_iter()
        .enumerate()
        .map(|(i, (name, duck_type))| {
            let original_type = overrides
                .contains_key(&name)
                .then(|| original.get(&name).cloned())
                .flatten();
            ColumnInfo {
                logical_type: LogicalType::from_duck_type(&duck_type),
                null_count: stats[1 + i * 2],
                distinct_estimate: stats[2 + i * 2],
                name,
                duck_type,
                original_type,
            }
        })
        .collect();
    Ok((columns, row_count))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

impl SortDir {
    pub fn sql(self) -> &'static str {
        match self {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSort {
    pub column: String,
    pub dir: SortDir,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPage {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Json>>,
    pub offset: u32,
    pub total_rows: i64,
}

pub fn preview(
    conn: &Connection,
    dataset_id: &str,
    columns: &[ColumnInfo],
    total_rows: i64,
    offset: u32,
    limit: u32,
    sort: Option<&PreviewSort>,
) -> AppResult<PreviewPage> {
    let view = view_name(dataset_id)?;
    let limit = limit.clamp(1, PREVIEW_PAGE_CAP);
    let order = match sort {
        Some(s) => {
            if !columns.iter().any(|c| c.name == s.column) {
                return Err(AppError::UnknownColumn(s.column.clone()));
            }
            format!(" ORDER BY {} {} NULLS LAST", quote_ident(&s.column), s.dir.sql())
        }
        None => String::new(),
    };
    let sql = format!(
        "SELECT * FROM {}{order} LIMIT {limit} OFFSET {offset}",
        quote_ident(&view)
    );
    let mut stmt = conn.prepare(&sql)?;
    let width = columns.len();
    let rows = stmt
        .query_map([], |r| {
            (0..width).map(|i| r.get::<_, Value>(i).map(to_json)).collect()
        })?
        .collect::<Result<Vec<Vec<Json>>, _>>()?;
    Ok(PreviewPage {
        columns: columns.iter().map(|c| c.name.clone()).collect(),
        rows,
        offset,
        total_rows,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueCount {
    pub value: Json,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStats {
    pub column: String,
    pub logical_type: LogicalType,
    pub row_count: i64,
    pub null_count: i64,
    pub distinct_count: i64,
    pub min: Json,
    pub max: Json,
    pub mean: Option<f64>,
    pub top_values: Vec<ValueCount>,
}

pub fn column_stats(
    conn: &Connection,
    dataset_id: &str,
    column: &ColumnInfo,
) -> AppResult<ColumnStats> {
    let view = quote_ident(&view_name(dataset_id)?);
    let q = quote_ident(&column.name);
    let mean = if column.logical_type.is_numeric() {
        format!("avg({q})::DOUBLE")
    } else {
        "NULL::DOUBLE".into()
    };
    let sql = format!(
        "SELECT count(*), count(*) - count({q}), approx_count_distinct({q}), min({q}), max({q}), {mean} FROM {view}"
    );
    let (row_count, null_count, distinct_count, min, max, mean) = conn.query_row(&sql, [], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            to_json(r.get::<_, Value>(3)?),
            to_json(r.get::<_, Value>(4)?),
            r.get::<_, Option<f64>>(5)?,
        ))
    })?;
    let top_values = distinct_values(conn, dataset_id, column, None, 10)?;
    Ok(ColumnStats {
        column: column.name.clone(),
        logical_type: column.logical_type,
        row_count,
        null_count,
        distinct_count,
        min,
        max,
        mean,
        top_values,
    })
}

/// Most frequent values of a column, optionally filtered by a case-insensitive search term.
pub fn distinct_values(
    conn: &Connection,
    dataset_id: &str,
    column: &ColumnInfo,
    search: Option<&str>,
    limit: u32,
) -> AppResult<Vec<ValueCount>> {
    let view = quote_ident(&view_name(dataset_id)?);
    let q = quote_ident(&column.name);
    let limit = limit.clamp(1, DISTINCT_CAP);
    let mut params: Vec<Value> = Vec::new();
    let filter = match search.filter(|s| !s.is_empty()) {
        Some(s) => {
            params.push(Value::Text(s.to_string()));
            format!(" WHERE contains(lower(CAST({q} AS VARCHAR)), lower(?))")
        }
        None => String::new(),
    };
    let sql = format!(
        "SELECT {q} AS v, count(*) AS n FROM {view}{filter} GROUP BY 1 ORDER BY n DESC, v ASC NULLS LAST LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |r| {
            Ok(ValueCount {
                value: to_json(r.get::<_, Value>(0)?),
                count: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
