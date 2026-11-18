//! Golden fixtures shared with the web build's TypeScript ports
//! (`src/lib/backend/web/crosscheck.test.ts`). Rust is the reference: run
//! `UPDATE_CROSSCHECK=1 cargo test crosscheck` to regenerate every `expect` after an intended change.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::db::expr;
use crate::db::query_builder::{build_query, SqlParam};
use crate::db::spec::QuerySpec;
use crate::error::AppError;
use crate::import::fingerprint;
use crate::model::{ColumnInfo, LogicalType};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/crosscheck.json")
}

fn param_json(p: &SqlParam) -> Value {
    match p {
        SqlParam::Text(s) => json!({ "text": s }),
        SqlParam::Int(i) => json!({ "int": i }),
        SqlParam::Float(f) => json!({ "float": f }),
        SqlParam::Bool(b) => json!({ "bool": b }),
    }
}

fn error_json(e: &AppError) -> Value {
    let mut v = serde_json::to_value(e).unwrap();
    v.as_object_mut().unwrap().retain(|k, _| k != "position" || matches!(e, AppError::InvalidExpression { .. }));
    json!({ "error": v })
}

fn schema(doc: &Value) -> Vec<ColumnInfo> {
    doc["schema"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| ColumnInfo {
            name: c["name"].as_str().unwrap().to_string(),
            logical_type: serde_json::from_value::<LogicalType>(c["logicalType"].clone()).unwrap(),
            duck_type: String::new(),
            null_count: 0,
            distinct_estimate: 0,
            original_type: None,
        })
        .collect()
}

fn query_expect(spec: &Value, cols: &[ColumnInfo]) -> Value {
    let spec: QuerySpec = serde_json::from_value(spec.clone()).expect("fixture specs must deserialize");
    match build_query(&spec, cols) {
        Ok(q) => json!({
            "sql": q.sql,
            "params": q.params.iter().map(param_json).collect::<Vec<_>>(),
            "limit": q.limit,
        }),
        Err(e) => error_json(&e),
    }
}

fn expr_expect(src: &str, cols: &[ColumnInfo]) -> Value {
    match expr::parse(src, cols) {
        Ok(p) => {
            let mut params = Vec::new();
            let sql = expr::compile(&p.ast, &mut params);
            json!({
                "sql": sql,
                "params": params.iter().map(param_json).collect::<Vec<_>>(),
                "isAggregate": p.is_aggregate,
                "columns": p.columns,
                "ast": p.ast,
            })
        }
        Err(e) => error_json(&e),
    }
}

fn fingerprint_bytes(case: &Value) -> Vec<u8> {
    if let Some(t) = case["text"].as_str() {
        return t.as_bytes().to_vec();
    }
    let unit = case["repeat"].as_str().unwrap().as_bytes();
    let mut out = unit.repeat(case["count"].as_u64().unwrap() as usize);
    if let Some(t) = case["tail"].as_str() {
        out.extend_from_slice(t.as_bytes());
    }
    out
}

fn fingerprint_expect(case: &Value) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("f.csv");
    let bytes = fingerprint_bytes(case);
    std::fs::write(&p, &bytes).unwrap();
    let f = fingerprint(&p).unwrap();
    json!({ "size": f.size, "partialSha256": f.partial_sha256 })
}

#[test]
fn crosscheck_fixtures_match_rust() {
    let path = fixture_path();
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let cols = schema(&doc);
    let update = std::env::var_os("UPDATE_CROSSCHECK").is_some();
    let mut mismatches = Vec::new();

    for section in ["queries", "expressions", "fingerprints"] {
        let cases = doc[section].as_array_mut().unwrap();
        for case in cases.iter_mut() {
            let actual = match section {
                "queries" => query_expect(&case["spec"], &cols),
                "expressions" => expr_expect(case["src"].as_str().unwrap(), &cols),
                _ => fingerprint_expect(case),
            };
            if update {
                case["expect"] = actual;
            } else if case["expect"] != actual {
                mismatches.push(format!("{section}: {case}\n  actual: {actual}"));
            }
        }
    }

    if update {
        std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
    }
    assert!(mismatches.is_empty(), "crosscheck mismatches:\n{}", mismatches.join("\n"));
}
