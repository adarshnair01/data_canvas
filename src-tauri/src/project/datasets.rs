//! Loading project datasets into DuckDB (from the linked source or an embedded Parquet copy),
//! Parquet export for Portable mode, and change detection against the saved schema/fingerprint.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::db::ident::{quote_ident, quote_literal, table_name, view_name};
use crate::db::schema;
use crate::error::{AppError, AppResult};
use crate::import::{self, csv, xlsx};
use crate::model::{ColumnInfo, DatasetMeta, Fingerprint, LogicalType, SourceKind};
use crate::project::format::{
    candidate_paths, extract_entry, has_entry, resolve_source, ProjectDataset,
};
use crate::state::Inner;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypeChange {
    pub name: String,
    pub before: LogicalType,
    pub after: LogicalType,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub type_changed: Vec<TypeChange>,
    pub row_count_before: i64,
    pub row_count_after: i64,
}

impl SchemaDiff {
    pub fn columns_changed(&self) -> bool {
        !(self.added.is_empty() && self.removed.is_empty() && self.type_changed.is_empty())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetChange {
    pub fingerprint_changed: bool,
    pub before: Fingerprint,
    pub after: Fingerprint,
    /// `None` when the dataset was loaded from its embedded copy and the source was not re-read.
    pub schema: Option<SchemaDiff>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LoadedFrom {
    Source,
    Embedded,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LoadStatus {
    Ok,
    /// Linked: data comes from the changed file, but the project keeps the saved fingerprint
    /// until the user refreshes. Portable: the embedded copy is in use; refresh re-reads the source.
    Changed { change: DatasetChange },
    Missing { searched: Vec<String> },
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetLoad {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub status: LoadStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loaded_from: Option<LoadedFrom>,
    /// Registered metadata; absent for missing or failed datasets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<DatasetMeta>,
}

impl DatasetLoad {
    pub fn is_loaded(&self) -> bool {
        self.meta.is_some()
    }
}

/// Content change: size or partial hash differ. Path and mtime alone (a moved or copied
/// file) do not count.
pub fn fingerprint_changed(before: &Fingerprint, after: &Fingerprint) -> bool {
    before.size != after.size || before.partial_sha256 != after.partial_sha256
}

pub fn schema_diff(before: &[ColumnInfo], after: &[ColumnInfo], rows_before: i64, rows_after: i64) -> SchemaDiff {
    let find = |cols: &[ColumnInfo], n: &str| cols.iter().find(|c| c.name == n).map(|c| c.logical_type);
    SchemaDiff {
        added: after.iter().filter(|c| find(before, &c.name).is_none()).map(|c| c.name.clone()).collect(),
        removed: before.iter().filter(|c| find(after, &c.name).is_none()).map(|c| c.name.clone()).collect(),
        type_changed: before
            .iter()
            .filter_map(|b| {
                let a = find(after, &b.name)?;
                (a != b.logical_type).then(|| TypeChange {
                    name: b.name.clone(),
                    before: b.logical_type,
                    after: a,
                })
            })
            .collect(),
        row_count_before: rows_before,
        row_count_after: rows_after,
    }
}

/// Apply type overrides that still match a column, then detect the schema.
fn finish_table(
    inner: &Inner,
    id: &str,
    overrides: &BTreeMap<String, LogicalType>,
) -> AppResult<(BTreeMap<String, LogicalType>, Vec<ColumnInfo>, i64)> {
    let conn = inner.pool.get()?;
    let base = schema::describe(&conn, &table_name(id)?)?;
    let kept: BTreeMap<String, LogicalType> = overrides
        .iter()
        .filter(|(name, _)| base.iter().any(|(n, _)| n == *name))
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    schema::create_view(&conn, id, &kept)?;
    let (columns, rows) = schema::detect_schema(&conn, id, &kept)?;
    Ok((kept, columns, rows))
}

/// Re-import `saved`'s source from `path` with the stored import options, keeping its id.
/// Does not register the result.
pub fn load_from_source(inner: &Inner, saved: &DatasetMeta, path: &Path) -> AppResult<DatasetMeta> {
    let fingerprint = import::fingerprint(path)?;
    {
        let conn = inner.pool.get()?;
        match saved.source.kind {
            SourceKind::Csv => {
                let opts = saved.source.csv_options.clone().unwrap_or_default();
                csv::import(&conn, &saved.id, path, &opts)?
            }
            SourceKind::Xlsx => {
                let sheet = saved
                    .source
                    .sheet
                    .as_deref()
                    .ok_or_else(|| AppError::query("Excel dataset has no sheet name"))?;
                xlsx::import(&conn, &saved.id, path, sheet, saved.source.header)?
            }
        }
    }
    let (type_overrides, columns, row_count) = finish_table(inner, &saved.id, &saved.type_overrides)?;
    let mut meta = saved.clone();
    meta.source.path = path.display().to_string();
    meta.fingerprint = fingerprint;
    meta.columns = columns;
    meta.row_count = row_count;
    meta.type_overrides = type_overrides;
    Ok(meta)
}

pub fn load_from_parquet(inner: &Inner, saved: &DatasetMeta, parquet: &Path) -> AppResult<DatasetMeta> {
    {
        let conn = inner.pool.get()?;
        conn.execute_batch(&format!(
            "CREATE OR REPLACE TABLE {} AS SELECT * FROM read_parquet({})",
            quote_ident(&table_name(&saved.id)?),
            quote_literal(&parquet.to_string_lossy())?
        ))?;
    }
    let (type_overrides, columns, row_count) = finish_table(inner, &saved.id, &saved.type_overrides)?;
    let mut meta = saved.clone();
    meta.columns = columns;
    meta.row_count = row_count;
    meta.type_overrides = type_overrides;
    Ok(meta)
}

/// DuckDB types accepted for typed CSV columns; anything else loads as VARCHAR.
/// Mirrors `loadableType` in `src/lib/backend/web/typedCsv.ts`.
fn loadable_type(t: &str) -> String {
    const SIMPLE: &[&str] = &[
        "BIGINT", "INTEGER", "SMALLINT", "TINYINT", "HUGEINT", "UBIGINT", "UINTEGER", "USMALLINT",
        "UTINYINT", "DOUBLE", "FLOAT", "REAL", "BOOLEAN", "DATE", "TIME", "TIMESTAMP",
        "TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS",
        "VARCHAR", "UUID",
    ];
    let up = t.trim().to_ascii_uppercase();
    let decimal = up
        .strip_prefix("DECIMAL(")
        .and_then(|r| r.strip_suffix(')'))
        .and_then(|r| r.split_once(','))
        .is_some_and(|(p, s)| {
            let s = s.strip_prefix(' ').unwrap_or(s);
            [p, s].iter().all(|n| (1..=2).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
        });
    if decimal || SIMPLE.contains(&up.as_str()) {
        up
    } else {
        "VARCHAR".into()
    }
}

/// Load an embedded typed CSV (written by the web version, which has no Parquet support). Column
/// types come from the saved metadata: the raw type before any override.
pub fn load_from_csv(inner: &Inner, saved: &DatasetMeta, csv: &Path) -> AppResult<DatasetMeta> {
    {
        let columns = saved
            .columns
            .iter()
            .map(|c| {
                let t = c.original_type.as_deref().unwrap_or(&c.duck_type);
                Ok(format!("{}: {}", quote_literal(&c.name)?, quote_literal(&loadable_type(t))?))
            })
            .collect::<AppResult<Vec<_>>>()?;
        let conn = inner.pool.get()?;
        conn.execute_batch(&format!(
            "CREATE OR REPLACE TABLE {} AS SELECT * FROM read_csv({}, header = true, auto_detect = false, \
             delim = ',', quote = '\"', escape = '\"', columns = {{{}}})",
            quote_ident(&table_name(&saved.id)?),
            quote_literal(&csv.to_string_lossy())?,
            columns.join(", ")
        ))?;
    }
    let (type_overrides, columns, row_count) = finish_table(inner, &saved.id, &saved.type_overrides)?;
    let mut meta = saved.clone();
    meta.columns = columns;
    meta.row_count = row_count;
    meta.type_overrides = type_overrides;
    Ok(meta)
}

/// Write the raw imported table (before type overrides, which are re-applied on load).
pub fn export_parquet(inner: &Inner, id: &str, dest: &Path) -> AppResult<()> {
    let conn = inner.pool.get()?;
    conn.execute_batch(&format!(
        "COPY (SELECT * FROM {}) TO {} (FORMAT parquet)",
        quote_ident(&table_name(id)?),
        quote_literal(&dest.to_string_lossy())?
    ))?;
    Ok(())
}

/// Drop every registered dataset's table and view and empty the registry.
pub fn clear_registry(inner: &Inner) -> AppResult<()> {
    let ids: Vec<String> = inner
        .datasets
        .read()
        .map_err(|_| AppError::Internal("dataset registry poisoned".into()))?
        .keys()
        .cloned()
        .collect();
    let conn = inner.pool.get()?;
    for id in &ids {
        conn.execute_batch(&format!(
            "DROP VIEW IF EXISTS {}; DROP TABLE IF EXISTS {};",
            quote_ident(&view_name(id)?),
            quote_ident(&table_name(id)?)
        ))?;
    }
    inner
        .datasets
        .write()
        .map_err(|_| AppError::Internal("dataset registry poisoned".into()))?
        .clear();
    Ok(())
}

pub struct LoadContext<'a> {
    pub project_dir: Option<&'a Path>,
    /// Archive that may hold `data/<id>.parquet` entries.
    pub archive: Option<&'a Path>,
    /// Open uses the embedded copy first; recovery re-reads the source first.
    pub prefer_embedded: bool,
    pub scratch: &'a Path,
}

fn unresolved(ds: &ProjectDataset, status: LoadStatus) -> DatasetLoad {
    DatasetLoad {
        id: ds.meta.id.clone(),
        name: ds.meta.name.clone(),
        status,
        loaded_from: None,
        meta: None,
    }
}

/// Load one project dataset and register it. Missing or failed datasets are not registered;
/// the caller keeps them so they can be relocated or saved back unchanged.
pub fn load_dataset(inner: &Inner, ctx: &LoadContext, ds: &ProjectDataset) -> DatasetLoad {
    if let Err(e) = crate::db::ident::validate_dataset_id(&ds.meta.id) {
        return unresolved(ds, LoadStatus::Failed { message: e.to_string() });
    }
    let saved = &ds.meta;
    let source = resolve_source(ctx.project_dir, ds);
    let embedded = ds
        .embedded
        .as_deref()
        .filter(|e| ctx.archive.is_some_and(|a| has_entry(a, e)));

    let result = match (embedded, &source) {
        (Some(entry), src) if ctx.prefer_embedded || src.is_none() => {
            load_embedded(inner, ctx, saved, entry, src.as_deref())
        }
        (_, Some(path)) => load_linked(inner, saved, path),
        (_, None) => {
            let searched = candidate_paths(ctx.project_dir, ds)
                .iter()
                .map(|p| p.display().to_string())
                .collect();
            return unresolved(ds, LoadStatus::Missing { searched });
        }
    };
    match result.and_then(|load| {
        if let Some(meta) = &load.meta {
            inner.put_dataset(meta.clone())?;
        }
        Ok(load)
    }) {
        Ok(load) => load,
        Err(e) => unresolved(ds, LoadStatus::Failed { message: e.to_string() }),
    }
}

fn load_embedded(
    inner: &Inner,
    ctx: &LoadContext,
    saved: &DatasetMeta,
    entry: &str,
    source: Option<&Path>,
) -> AppResult<DatasetLoad> {
    let archive = ctx.archive.expect("embedded entries imply an archive");
    let csv = entry.to_ascii_lowercase().ends_with(".csv");
    let tmp = ctx.scratch.join(format!("{}.{}", saved.id, if csv { "csv" } else { "parquet" }));
    extract_entry(archive, entry, &tmp)?;
    let loaded = if csv { load_from_csv(inner, saved, &tmp) } else { load_from_parquet(inner, saved, &tmp) };
    let _ = std::fs::remove_file(&tmp);
    let mut meta = loaded?;
    let mut status = LoadStatus::Ok;
    if let Some(path) = source {
        meta.source.path = path.display().to_string();
        if let Ok(now) = import::fingerprint(path) {
            if fingerprint_changed(&saved.fingerprint, &now) {
                status = LoadStatus::Changed {
                    change: DatasetChange {
                        fingerprint_changed: true,
                        before: saved.fingerprint.clone(),
                        after: now,
                        schema: None,
                    },
                };
            }
        }
    }
    Ok(DatasetLoad {
        id: saved.id.clone(),
        name: saved.name.clone(),
        status,
        loaded_from: Some(LoadedFrom::Embedded),
        meta: Some(meta),
    })
}

fn load_linked(inner: &Inner, saved: &DatasetMeta, path: &Path) -> AppResult<DatasetLoad> {
    let mut meta = load_from_source(inner, saved, path)?;
    let fp_changed = fingerprint_changed(&saved.fingerprint, &meta.fingerprint);
    let diff = schema_diff(&saved.columns, &meta.columns, saved.row_count, meta.row_count);
    let status = if fp_changed || diff.columns_changed() {
        let change = DatasetChange {
            fingerprint_changed: fp_changed,
            before: saved.fingerprint.clone(),
            after: meta.fingerprint.clone(),
            schema: Some(diff),
        };
        meta.fingerprint = saved.fingerprint.clone();
        LoadStatus::Changed { change }
    } else {
        LoadStatus::Ok
    };
    Ok(DatasetLoad {
        id: saved.id.clone(),
        name: saved.name.clone(),
        status,
        loaded_from: Some(LoadedFrom::Source),
        meta: Some(meta),
    })
}

/// Re-read a dataset from `path`, adopt the new fingerprint, and report what changed
/// relative to `previous`. Used by Reload source, Refresh and Relocate.
pub fn refresh_from(inner: &Inner, previous: &DatasetMeta, path: &Path) -> AppResult<DatasetLoad> {
    let meta = load_from_source(inner, previous, path)?;
    inner.put_dataset(meta.clone())?;
    let fp_changed = fingerprint_changed(&previous.fingerprint, &meta.fingerprint);
    let diff = schema_diff(&previous.columns, &meta.columns, previous.row_count, meta.row_count);
    let status = if fp_changed || diff.columns_changed() {
        LoadStatus::Changed {
            change: DatasetChange {
                fingerprint_changed: fp_changed,
                before: previous.fingerprint.clone(),
                after: meta.fingerprint.clone(),
                schema: Some(diff),
            },
        }
    } else {
        LoadStatus::Ok
    };
    Ok(DatasetLoad {
        id: meta.id.clone(),
        name: meta.name.clone(),
        status,
        loaded_from: Some(LoadedFrom::Source),
        meta: Some(meta),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, t: LogicalType) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            logical_type: t,
            duck_type: String::new(),
            null_count: 0,
            distinct_estimate: 0,
            original_type: None,
        }
    }

    #[test]
    fn diffs_columns() {
        let before = [col("a", LogicalType::String), col("b", LogicalType::Integer), col("c", LogicalType::Float)];
        let after = [col("a", LogicalType::String), col("b", LogicalType::String), col("d", LogicalType::Date)];
        let d = schema_diff(&before, &after, 10, 12);
        assert_eq!(d.added, vec!["d"]);
        assert_eq!(d.removed, vec!["c"]);
        assert_eq!(
            d.type_changed,
            vec![TypeChange { name: "b".into(), before: LogicalType::Integer, after: LogicalType::String }]
        );
        assert!(d.columns_changed());
        assert!(!schema_diff(&before, &before, 1, 1).columns_changed());
    }

    #[test]
    fn fingerprint_change_ignores_path_and_mtime() {
        let a = Fingerprint { path: "/a".into(), size: 5, modified_ms: 1, partial_sha256: "h".into() };
        let moved = Fingerprint { path: "/b".into(), modified_ms: 2, ..a.clone() };
        assert!(!fingerprint_changed(&a, &moved));
        assert!(fingerprint_changed(&a, &Fingerprint { size: 6, ..a.clone() }));
        assert!(fingerprint_changed(&a, &Fingerprint { partial_sha256: "x".into(), ..a.clone() }));
    }
}
