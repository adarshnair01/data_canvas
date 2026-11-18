//! CSV import through DuckDB `read_csv_auto`.

use std::path::Path;

use duckdb::Connection;

use crate::db::ident::{quote_ident, quote_literal, table_name};
use crate::error::{AppError, AppResult};
use crate::model::CsvOptions;

/// Built-in DuckDB encodings; others would need an extension download, which we never do.
pub const ENCODINGS: [&str; 3] = ["utf-8", "utf-16", "latin-1"];
pub const DELIMITERS: [&str; 5] = [",", ";", "\t", "|", ":"];

fn options_sql(opts: &CsvOptions) -> AppResult<String> {
    // `skip = 0`: otherwise the sniffer may treat leading rows as a preamble and silently drop them.
    let mut parts = vec![
        "auto_detect = true".to_string(),
        "sample_size = 20480".to_string(),
        "skip = 0".to_string(),
    ];
    if let Some(d) = opts.delimiter.as_deref().filter(|d| !d.is_empty()) {
        if !DELIMITERS.contains(&d) {
            return Err(AppError::query(format!("unsupported delimiter {d:?}")));
        }
        let lit = if d == "\t" { "'\\t'".to_string() } else { quote_literal(d)? };
        parts.push(format!("delim = {lit}"));
    }
    if let Some(h) = opts.header {
        parts.push(format!("header = {h}"));
    }
    if let Some(e) = opts.encoding.as_deref().filter(|e| !e.is_empty()) {
        let e = e.to_ascii_lowercase();
        if !ENCODINGS.contains(&e.as_str()) {
            return Err(AppError::UnsupportedEncoding(format!(
                "{e} (supported: {})",
                ENCODINGS.join(", ")
            )));
        }
        parts.push(format!("encoding = {}", quote_literal(&e)?));
    }
    if opts.skip_malformed {
        parts.push("ignore_errors = true".into());
    }
    Ok(parts.join(", "))
}

/// Map DuckDB CSV failures to typed errors the UI can explain.
fn classify(err: duckdb::Error) -> AppError {
    let msg = err.to_string();
    let lower = msg.to_ascii_lowercase();
    if lower.contains("invalid unicode") || lower.contains("byte sequence") {
        AppError::UnsupportedEncoding(first_line(&msg))
    } else if lower.contains("no files found") || lower.contains("no such file") {
        AppError::FileNotFound(first_line(&msg))
    } else if lower.contains("csv") || lower.contains("column") || lower.contains("convert") {
        AppError::MalformedRows(format!(
            "{} Enable \"Skip malformed rows\" to import the remaining rows.",
            first_line(&msg)
        ))
    } else {
        AppError::from(err)
    }
}

fn first_line(s: &str) -> String {
    s.lines().take(3).collect::<Vec<_>>().join(" ").trim().to_string()
}

pub fn import(conn: &Connection, dataset_id: &str, path: &Path, opts: &CsvOptions) -> AppResult<()> {
    super::ensure_file(path)?;
    if std::fs::metadata(path)?.len() == 0 {
        return Err(AppError::EmptyFile);
    }
    let table = quote_ident(&table_name(dataset_id)?);
    let path_lit = quote_literal(&path.to_string_lossy())?;
    let sql = format!(
        "CREATE OR REPLACE TABLE {table} AS SELECT * FROM read_csv_auto({path_lit}, {})",
        options_sql(opts)?
    );
    conn.execute_batch(&sql).map_err(classify)?;
    let rows: i64 = conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
    if rows == 0 {
        conn.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))?;
        return Err(AppError::EmptyFile);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{create_view, detect_schema};
    use crate::model::LogicalType;
    use std::collections::BTreeMap;

    fn conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn imports_and_detects_schema() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sales.csv");
        std::fs::write(
            &p,
            "region;amount;day;flag\nNorth;1.5;2024-01-01;true\nSouth;2;2024-01-02;false\n;3;2024-01-03;true\n",
        )
        .unwrap();
        let c = conn();
        import(&c, "a1", &p, &CsvOptions { delimiter: Some(";".into()), ..Default::default() }).unwrap();
        create_view(&c, "a1", &BTreeMap::new()).unwrap();
        let (cols, rows) = detect_schema(&c, "a1", &BTreeMap::new()).unwrap();
        assert_eq!(rows, 3);
        let types: Vec<_> = cols.iter().map(|c| c.logical_type).collect();
        assert_eq!(
            types,
            vec![LogicalType::String, LogicalType::Float, LogicalType::Date, LogicalType::Boolean]
        );
        assert_eq!(cols[0].null_count, 1);
    }

    #[test]
    fn path_with_quotes_is_escaped() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("it's; DROP TABLE x.csv");
        std::fs::write(&p, "a\n1\n").unwrap();
        let c = conn();
        import(&c, "a2", &p, &CsvOptions::default()).unwrap();
    }

    #[test]
    fn typed_errors() {
        let dir = tempfile::tempdir().unwrap();
        let c = conn();
        let empty = dir.path().join("empty.csv");
        std::fs::write(&empty, "").unwrap();
        assert!(matches!(import(&c, "e1", &empty, &CsvOptions::default()), Err(AppError::EmptyFile)));

        let header_only = dir.path().join("h.csv");
        std::fs::write(&header_only, "a,b\n").unwrap();
        assert!(matches!(import(&c, "e2", &header_only, &CsvOptions::default()), Err(AppError::EmptyFile)));

        assert!(matches!(
            import(&c, "e3", Path::new("/nope/missing.csv"), &CsvOptions::default()),
            Err(AppError::FileNotFound(_))
        ));

        let opts = CsvOptions { encoding: Some("shift_jis".into()), ..Default::default() };
        assert!(matches!(import(&c, "e4", &header_only, &opts), Err(AppError::UnsupportedEncoding(_))));

        let opts = CsvOptions { delimiter: Some("'); DROP".into()), ..Default::default() };
        assert!(import(&c, "e5", &header_only, &opts).is_err());

        let bad_utf8 = dir.path().join("latin.csv");
        std::fs::write(&bad_utf8, b"name,v\ncaf\xe9,1\nna\xefve,2\n").unwrap();
        let utf8 = CsvOptions { encoding: Some("utf-8".into()), ..Default::default() };
        assert!(matches!(import(&c, "e6", &bad_utf8, &utf8), Err(AppError::UnsupportedEncoding(_))));
        let latin = CsvOptions { encoding: Some("latin-1".into()), ..Default::default() };
        import(&c, "e7", &bad_utf8, &latin).unwrap();
    }

    #[test]
    fn malformed_rows_are_reported_or_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.csv");
        let mut s = String::from("a,b,c\n");
        for i in 0..50 {
            s.push_str(&format!("{i},{i},{i}\n"));
        }
        s.push_str("1,2,3,4,5\n");
        std::fs::write(&p, s).unwrap();
        let c = conn();
        let strict = CsvOptions { delimiter: Some(",".into()), header: Some(true), ..Default::default() };
        let r = import(&c, "m1", &p, &strict);
        assert!(matches!(r, Err(AppError::MalformedRows(_))), "{r:?}");
        let lenient = CsvOptions { skip_malformed: true, ..strict };
        import(&c, "m2", &p, &lenient).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM ds_m2", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 50);
    }
}
