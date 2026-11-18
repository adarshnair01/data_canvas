//! CSV export through DuckDB `COPY`, plus atomic writes for frontend-rendered PNG/PDF bytes.
//!
//! Every export goes to a temporary file next to the destination and is renamed into place,
//! so a failed or cancelled export never leaves a truncated file behind.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use duckdb::types::Value;
use duckdb::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::db::ident::{quote_ident, quote_literal, view_name};
use crate::db::query_builder::{build_export_query, SqlParam};
use crate::db::spec::QuerySpec;
use crate::error::{AppError, AppResult};
use crate::model::ColumnInfo;

/// Extensions accepted by [`write_bytes`]; CSV is always written by DuckDB.
pub const BINARY_EXTENSIONS: [&str; 2] = ["png", "pdf"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub rows: u64,
}

/// Header label for one `QuerySpec` output id.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnLabel {
    pub id: String,
    pub label: String,
}

/// Export destinations come from a native Save dialog, so they must be absolute paths
/// into an existing directory.
pub fn validate_destination(path: &str) -> AppResult<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::Io("invalid export path".into()));
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(AppError::Io(format!("export path must be absolute: {path}")));
    }
    if p.file_name().is_none() {
        return Err(AppError::Io(format!("export path has no file name: {path}")));
    }
    match p.parent() {
        Some(dir) if dir.is_dir() => Ok(p),
        _ => Err(AppError::FileNotFound(format!("folder does not exist for {path}"))),
    }
}

fn temp_sibling(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dest.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()))
}

fn commit(tmp: &Path, dest: &Path) -> AppResult<()> {
    fs::rename(tmp, dest).inspect_err(|_| {
        let _ = fs::remove_file(tmp);
    })?;
    Ok(())
}

/// `COPY (<select>) TO <dest>` as CSV with a header row. Returns the number of rows written.
pub fn copy_csv(conn: &Connection, select_sql: &str, params: &[SqlParam], dest: &Path) -> AppResult<u64> {
    let tmp = temp_sibling(dest);
    let target = quote_literal(&tmp.to_string_lossy())?;
    let sql = format!("COPY ({select_sql}) TO {target} (FORMAT csv, HEADER true, DELIMITER ',')");
    let values: Vec<Value> = params.iter().map(SqlParam::to_value).collect();
    let rows = match conn.execute(&sql, params_from_iter(values.iter())) {
        Ok(n) => n as u64,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
    };
    commit(&tmp, dest)?;
    Ok(rows)
}

/// Every row and column of a dataset, with type overrides applied.
pub fn export_dataset_csv(conn: &Connection, dataset_id: &str, dest: &Path) -> AppResult<u64> {
    let relation = quote_ident(&view_name(dataset_id)?);
    copy_csv(conn, &format!("SELECT * FROM {relation}"), &[], dest)
}

/// A widget's `QuerySpec` result without the chart row cap. `labels` renames output ids to
/// human-readable headers; ids without a label keep their id.
pub fn export_query_csv(
    conn: &Connection,
    spec: &QuerySpec,
    schema: &[ColumnInfo],
    labels: &[ColumnLabel],
    dest: &Path,
) -> AppResult<u64> {
    let built = build_export_query(spec, schema)?;
    let mut used = HashSet::new();
    let select: Vec<String> = built
        .columns
        .iter()
        .map(|c| {
            let base = labels
                .iter()
                .find(|l| l.id == c.id)
                .map(|l| l.label.trim())
                .filter(|l| !l.is_empty())
                .unwrap_or(&c.id)
                .to_string();
            let mut label = base.clone();
            let mut n = 2;
            while !used.insert(label.to_lowercase()) {
                label = format!("{base} ({n})");
                n += 1;
            }
            format!("{} AS {}", quote_ident(&c.id), quote_ident(&label))
        })
        .collect();
    let sql = format!("SELECT {} FROM ({}) AS q", select.join(", "), built.sql);
    copy_csv(conn, &sql, &built.params, dest)
}

/// Atomically write PNG/PDF bytes rendered in the WebView.
pub fn write_bytes(dest: &Path, bytes: &[u8]) -> AppResult<()> {
    let ext = dest
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !BINARY_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::UnsupportedFile(format!(
            "exports must be .png or .pdf, got '{}'",
            dest.display()
        )));
    }
    if bytes.is_empty() {
        return Err(AppError::Io("nothing to write".into()));
    }
    let tmp = temp_sibling(dest);
    fs::write(&tmp, bytes).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    commit(&tmp, dest)
}

/// Decode a `%XX`-encoded header value (produced by `encodeURIComponent`).
pub fn percent_decode(s: &str) -> AppResult<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| AppError::Io("malformed export path".into()))?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| AppError::Io("export path is not UTF-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{create_view, detect_schema};
    use serde_json::json;
    use std::collections::BTreeMap;

    fn setup() -> (Connection, Vec<ColumnInfo>) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE ds_t1 (region VARCHAR, revenue DOUBLE, note VARCHAR);
             INSERT INTO ds_t1 SELECT
               CASE WHEN range % 3 = 0 THEN 'North' WHEN range % 3 = 1 THEN 'South' ELSE 'East' END,
               range::DOUBLE,
               CASE WHEN range = 0 THEN 'has \"quotes\", commas' ELSE NULL END
             FROM range(7000);",
        )
        .unwrap();
        create_view(&conn, "t1", &BTreeMap::new()).unwrap();
        let (cols, _) = detect_schema(&conn, "t1", &BTreeMap::new()).unwrap();
        (conn, cols)
    }

    fn no_temp_files(dir: &Path) {
        let leftovers: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }

    #[test]
    fn exports_full_dataset_with_header() {
        let (conn, _) = setup();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("all rows's.csv");
        let rows = export_dataset_csv(&conn, "t1", &dest).unwrap();
        assert_eq!(rows, 7000);
        let text = fs::read_to_string(&dest).unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("region,revenue,note"));
        assert_eq!(lines.next(), Some("North,0.0,\"has \"\"quotes\"\", commas\""));
        assert_eq!(text.lines().count(), 7001);
        no_temp_files(dir.path());
    }

    #[test]
    fn exports_widget_query_uncapped_with_labels_and_bound_filters() {
        let (conn, cols) = setup();
        let dir = tempfile::tempdir().unwrap();
        let spec: QuerySpec = serde_json::from_value(json!({
            "datasetId": "t1",
            "mode": "raw",
            "dimensions": [{"id": "d0", "field": "region"}],
            "measures": [{"id": "m0", "source": {"type": "column", "column": "revenue"}, "agg": "none"}],
            "filters": [{"kind": "in", "field": "region", "values": ["North", "South"]}],
            "sort": [{"by": "m0", "dir": "asc"}]
        }))
        .unwrap();
        let labels = vec![
            ColumnLabel { id: "d0".into(), label: "Region \"name\"".into() },
            ColumnLabel { id: "m0".into(), label: "region \"NAME\"".into() },
        ];
        let dest = dir.path().join("widget.csv");
        let rows = export_query_csv(&conn, &spec, &cols, &labels, &dest).unwrap();
        // 2/3 of 7000 rows, beyond the 5,000-row chart cap.
        assert_eq!(rows, 4667);
        let text = fs::read_to_string(&dest).unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("\"Region \"\"name\"\"\",\"region \"\"NAME\"\" (2)\""));
        assert_eq!(lines.next(), Some("North,0.0"));
        assert_eq!(lines.next(), Some("South,1.0"));
        no_temp_files(dir.path());

        let agg: QuerySpec = serde_json::from_value(json!({
            "datasetId": "t1",
            "dimensions": [{"id": "d0", "field": "region"}],
            "measures": [{"id": "n", "source": {"type": "rows"}, "agg": "count"}],
            "sort": [{"by": "d0", "dir": "asc"}],
            "limit": 2
        }))
        .unwrap();
        let dest = dir.path().join("top2.csv");
        assert_eq!(export_query_csv(&conn, &agg, &cols, &[], &dest).unwrap(), 2);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "d0,n\nEast,2333\nNorth,2334\n");
    }

    #[test]
    fn failed_export_leaves_no_files_and_keeps_existing_destination() {
        let (conn, cols) = setup();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("keep.csv");
        fs::write(&dest, "old").unwrap();
        let bad: QuerySpec = serde_json::from_value(json!({
            "datasetId": "t1",
            "dimensions": [{"id": "d0", "field": "region\"; DROP TABLE ds_t1; --"}]
        }))
        .unwrap();
        assert!(export_query_csv(&conn, &bad, &cols, &[], &dest).is_err());
        assert!(export_dataset_csv(&conn, "nope", &dest).is_err());
        assert!(export_dataset_csv(&conn, "../t1", &dest).is_err());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "old");
        no_temp_files(dir.path());
    }

    #[test]
    fn validates_destinations() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_destination("relative.csv").is_err());
        assert!(validate_destination("").is_err());
        let missing = dir.path().join("missing").join("x.csv");
        assert!(validate_destination(&missing.to_string_lossy()).is_err());
        let ok = dir.path().join("x.csv");
        assert_eq!(validate_destination(&ok.to_string_lossy()).unwrap(), ok);
    }

    #[test]
    fn writes_png_and_pdf_bytes_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("chart.PNG");
        write_bytes(&png, b"\x89PNG data").unwrap();
        assert_eq!(fs::read(&png).unwrap(), b"\x89PNG data");
        assert!(write_bytes(&dir.path().join("evil.sh"), b"x").is_err());
        assert!(write_bytes(&dir.path().join("empty.pdf"), b"").is_err());
        no_temp_files(dir.path());
    }

    #[test]
    fn decodes_percent_encoded_paths() {
        assert_eq!(
            percent_decode("%2FUsers%2Fme%2FQ3%20Review%20%C3%A9.pdf").unwrap(),
            "/Users/me/Q3 Review é.pdf"
        );
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%2").is_err());
    }
}
