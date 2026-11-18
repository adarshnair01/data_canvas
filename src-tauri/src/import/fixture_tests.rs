//! Import tests against the committed fixtures in `tests/fixtures` (see `generate.py`), plus a
//! ~1M-row CSV generated on the fly so it never has to be committed.

use std::io::{BufWriter, Write};
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::commands::dataset::{import_csv_blocking, import_xlsx_blocking};
use crate::db::query_builder::{build_query, execute};
use crate::db::spec::QuerySpec;
use crate::error::AppError;
use crate::import::xlsx;
use crate::model::{CsvOptions, LogicalType};
use crate::state::AppState;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn types(meta: &crate::model::DatasetMeta) -> Vec<(String, LogicalType)> {
    meta.columns.iter().map(|c| (c.name.clone(), c.logical_type)).collect()
}

fn number(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or_else(|| panic!("not a number: {v}"))
}

#[test]
fn multi_sheet_workbook_imports_each_sheet() {
    let path = fixture("multi_sheet.xlsx");
    assert_eq!(xlsx::list_sheets(&path).unwrap(), vec!["Sales", "Targets", "Notes"]);

    let state = AppState::new().unwrap();
    let sales = import_xlsx_blocking(&state.0, path.clone(), "Sales".into(), true, None).unwrap();
    assert_eq!(sales.row_count, 12);
    assert_eq!(sales.name, "multi_sheet – Sales");
    assert_eq!(
        types(&sales),
        vec![
            ("order_date".into(), LogicalType::Date),
            ("region".into(), LogicalType::String),
            ("product".into(), LogicalType::String),
            ("units".into(), LogicalType::Integer),
            ("revenue".into(), LogicalType::Float),
        ]
    );

    let targets = import_xlsx_blocking(&state.0, path.clone(), "Targets".into(), true, None).unwrap();
    assert_eq!(targets.row_count, 4);
    assert_eq!(
        types(&targets),
        vec![
            ("region".into(), LogicalType::String),
            ("target".into(), LogicalType::Float),
            ("met".into(), LogicalType::Boolean),
        ]
    );

    let empty = import_xlsx_blocking(&state.0, path, "Notes".into(), true, None);
    assert!(matches!(empty, Err(AppError::EmptySheet(_))), "{empty:?}");
}

#[test]
fn truncated_workbook_is_rejected() {
    let path = fixture("malformed.xlsx");
    assert!(matches!(xlsx::list_sheets(&path), Err(AppError::UnsupportedFile(_))));
    let state = AppState::new().unwrap();
    let r = import_xlsx_blocking(&state.0, path, "Sales".into(), true, None);
    assert!(matches!(r, Err(AppError::UnsupportedFile(_))), "{r:?}");
}

#[test]
fn malformed_csv_is_reported_then_skipped() {
    let path = fixture("malformed.csv");
    let state = AppState::new().unwrap();
    let strict = CsvOptions { delimiter: Some(",".into()), header: Some(true), ..Default::default() };
    let r = import_csv_blocking(&state.0, path.clone(), None, strict.clone());
    assert!(matches!(r, Err(AppError::MalformedRows(_))), "{r:?}");

    let lenient = CsvOptions { skip_malformed: true, ..strict };
    let meta = import_csv_blocking(&state.0, path, None, lenient).unwrap();
    assert_eq!(meta.row_count, 49);
    assert_eq!(meta.name, "malformed");
}

#[test]
fn million_row_csv_imports_and_aggregates() {
    const ROWS: u64 = 1_000_000;
    const REGIONS: [&str; 4] = ["North", "South", "East", "West"];
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.csv");
    {
        let mut w = BufWriter::new(std::fs::File::create(&path).unwrap());
        writeln!(w, "id,order_date,region,amount").unwrap();
        for i in 0..ROWS {
            let day = 1 + i % 28;
            let month = 1 + (i / 28) % 12;
            writeln!(w, "{i},2025-{month:02}-{day:02},{},{}", REGIONS[(i % 4) as usize], i % 100).unwrap();
        }
    }

    let state = AppState::new().unwrap();
    let meta = import_csv_blocking(&state.0, path, None, CsvOptions::default()).unwrap();
    assert_eq!(meta.row_count as u64, ROWS);
    assert_eq!(
        types(&meta),
        vec![
            ("id".into(), LogicalType::Integer),
            ("order_date".into(), LogicalType::Date),
            ("region".into(), LogicalType::String),
            ("amount".into(), LogicalType::Integer),
        ]
    );

    let spec: QuerySpec = serde_json::from_value(json!({
        "datasetId": meta.id,
        "dimensions": [{ "id": "d0", "field": "region" }],
        "measures": [
            { "id": "m0", "source": { "type": "column", "column": "amount" }, "agg": "sum" },
            { "id": "m1", "source": { "type": "rows" }, "agg": "count" }
        ],
        "sort": [{ "by": "d0", "dir": "asc" }]
    }))
    .unwrap();
    let built = build_query(&spec, &meta.columns).unwrap();
    let conn = state.0.pool.get().unwrap();
    let result = execute(&conn, &built).unwrap();
    assert_eq!(result.rows.len(), 4);
    let total: f64 = result.rows.iter().map(|r| number(&r[1])).sum();
    let count: f64 = result.rows.iter().map(|r| number(&r[2])).sum();
    assert_eq!(total, (ROWS / 100 * (0..100).sum::<u64>()) as f64);
    assert_eq!(count, ROWS as f64);
}
