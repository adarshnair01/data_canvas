//! End-to-end project tests against a real in-memory DuckDB.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::commands::dataset::import_csv_blocking;
use crate::error::AppError;
use crate::model::{CsvOptions, LogicalType};
use crate::project::datasets::{LoadStatus, LoadedFrom};
use crate::project::format::{StorageMode, FORMAT_VERSION, MANIFEST_ENTRY, PROJECT_ENTRY};
use crate::project::service::*;
use crate::project::session::ProjectSession;
use crate::state::{AppState, Inner};

struct Env {
    state: AppState,
    session: ProjectSession,
}

impl Env {
    fn new() -> Self {
        Self {
            state: AppState::new().unwrap(),
            session: ProjectSession::default(),
        }
    }
    fn inner(&self) -> &Inner {
        &self.state.0
    }
    fn import(&self, path: &Path) -> String {
        import_csv_blocking(self.inner(), path.to_path_buf(), None, CsvOptions::default())
            .unwrap()
            .id
    }
    fn count(&self, id: &str) -> i64 {
        let conn = self.inner().pool.get().unwrap();
        conn.query_row(&format!("SELECT count(*) FROM dsv_{id}"), [], |r| r.get(0)).unwrap()
    }
}

fn doc() -> Value {
    json!({
        "id": "pr_test1",
        "name": "Sales review",
        "activeDashboardId": "db_1",
        "dashboards": [{
            "id": "db_1", "name": "Main",
            "widgets": [{ "id": "w_1", "datasetId": "x", "chartType": "bar" }],
            "layout": [{ "i": "w_1", "x": 0, "y": 0, "w": 6, "h": 8 }],
            "globalFilters": [{ "id": "gf_1", "kind": "in", "field": "region", "datasetId": null, "values": ["North"] }]
        }],
        "metrics": [{ "id": "m_1", "name": "Margin", "expression": "SUM(amount) * 0.2" }]
    })
}

fn write_csv(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

const SALES: &str = "region,amount\nNorth,10\nSouth,20\nEast,30\n";

fn entries(path: &Path) -> Vec<String> {
    let z = ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut names: Vec<String> = z.file_names().map(|s| s.unwrap().to_string()).collect();
    names.sort();
    names
}

fn read_json(path: &Path, entry: &str) -> Value {
    let mut z = ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut s = String::new();
    z.by_name(entry).unwrap().read_to_string(&mut s).unwrap();
    serde_json::from_str(&s).unwrap()
}

#[test]
fn linked_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("data/sales.csv");
    write_csv(&csv, SALES);
    let project = dir.path().join("Review.datacanvas");

    let a = Env::new();
    let id = a.import(&csv);
    let saved = save_project(a.inner(), &a.session, &project, StorageMode::Linked, doc()).unwrap();
    assert_eq!(saved.dataset_count, 1);
    assert_eq!(entries(&project), vec![MANIFEST_ENTRY, PROJECT_ENTRY]);

    let manifest = read_json(&project, MANIFEST_ENTRY);
    assert_eq!(manifest["formatVersion"], FORMAT_VERSION);
    assert_eq!(manifest["appVersion"], env!("CARGO_PKG_VERSION"));
    let body = read_json(&project, PROJECT_ENTRY);
    assert_eq!(body["mode"], "linked");
    let ds = &body["datasets"][0];
    assert_eq!(ds["relativePath"], "data/sales.csv");
    assert_eq!(ds["source"]["path"], csv.display().to_string());
    assert_eq!(ds["columns"].as_array().unwrap().len(), 2);
    assert!(ds["fingerprint"]["partialSha256"].is_string());

    let b = Env::new();
    let opened = open_project(b.inner(), &b.session, &project).unwrap();
    assert_eq!(opened.project, doc());
    assert_eq!(opened.migrated_from, None);
    assert_eq!(opened.datasets.len(), 1);
    let load = &opened.datasets[0];
    assert!(matches!(load.status, LoadStatus::Ok), "{:?}", load.status);
    assert_eq!(load.loaded_from, Some(LoadedFrom::Source));
    assert_eq!(load.id, id);
    assert_eq!(b.count(&id), 3);
    assert_eq!(b.inner().dataset(&id).unwrap().columns.len(), 2);
}

#[test]
fn opening_replaces_session_datasets() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let project = dir.path().join("p.datacanvas");
    let a = Env::new();
    a.import(&csv);
    save_project(a.inner(), &a.session, &project, StorageMode::Linked, doc()).unwrap();
    let stray = a.import(&csv);
    open_project(a.inner(), &a.session, &project).unwrap();
    assert!(a.inner().dataset(&stray).is_err());
    assert_eq!(a.inner().datasets.read().unwrap().len(), 1);
}

#[test]
fn portable_embeds_parquet_and_opens_without_source() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let project = dir.path().join("Portable.datacanvas");

    let a = Env::new();
    let id = a.import(&csv);
    let mut overrides = BTreeMap::new();
    overrides.insert("amount".to_string(), LogicalType::String);
    {
        let conn = a.inner().pool.get().unwrap();
        crate::db::schema::create_view(&conn, &id, &overrides).unwrap();
        let mut meta = a.inner().dataset(&id).unwrap();
        meta.columns = crate::db::schema::detect_schema(&conn, &id, &overrides).unwrap().0;
        meta.type_overrides = overrides.clone();
        a.inner().put_dataset(meta).unwrap();
    }
    save_project(a.inner(), &a.session, &project, StorageMode::Portable, doc()).unwrap();
    let parquet = format!("data/{id}.parquet");
    assert!(entries(&project).contains(&parquet));
    assert_eq!(read_json(&project, PROJECT_ENTRY)["datasets"][0]["embedded"], parquet);

    fs::remove_file(&csv).unwrap();
    let b = Env::new();
    let opened = open_project(b.inner(), &b.session, &project).unwrap();
    let load = &opened.datasets[0];
    assert!(matches!(load.status, LoadStatus::Ok), "{:?}", load.status);
    assert_eq!(load.loaded_from, Some(LoadedFrom::Embedded));
    assert_eq!(b.count(&id), 3);
    let meta = b.inner().dataset(&id).unwrap();
    assert_eq!(meta.type_overrides, overrides);
    assert_eq!(meta.column("amount").unwrap().logical_type, LogicalType::String);
}

/// Projects saved by the web version embed typed CSV instead of Parquet.
#[test]
fn opens_web_projects_with_embedded_csv() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, "region,amount,day\nNorth,10,2024-01-02\nSouth,20.5,2024-02-03\n");
    let a = Env::new();
    let id = a.import(&csv);
    let mut meta = a.inner().dataset(&id).unwrap();
    let mut overrides = BTreeMap::new();
    overrides.insert("amount".to_string(), LogicalType::String);
    meta.type_overrides = overrides.clone();
    let types: Vec<String> = meta.columns.iter().map(|c| c.duck_type.clone()).collect();
    assert_eq!(types, vec!["VARCHAR", "DOUBLE", "DATE"]);

    let project = dir.path().join("web.datacanvas");
    let entry = format!("data/{id}.csv");
    let mut ds = serde_json::to_value(&meta).unwrap();
    ds["embedded"] = json!(entry);
    let body = json!({
        "mode": "portable",
        "savedAt": "2026-11-18T00:00:00.000Z",
        "project": doc(),
        "datasets": [ds],
    });
    let mut z = ZipWriter::new(File::create(&project).unwrap());
    let opts = SimpleFileOptions::default();
    z.start_file(MANIFEST_ENTRY, opts).unwrap();
    z.write_all(json!({ "formatVersion": 1, "appVersion": "0.1.0" }).to_string().as_bytes()).unwrap();
    z.start_file(PROJECT_ENTRY, opts).unwrap();
    z.write_all(body.to_string().as_bytes()).unwrap();
    z.start_file(&entry, opts).unwrap();
    z.write_all(b"\"region\",\"amount\",\"day\"\n\"North\",10.0,2024-01-02\n,20.5,2024-02-03\n\"a,\"\"b\",1e3,\n").unwrap();
    z.finish().unwrap();
    fs::remove_file(&csv).unwrap();

    let b = Env::new();
    let opened = open_project(b.inner(), &b.session, &project).unwrap();
    let load = &opened.datasets[0];
    assert!(matches!(load.status, LoadStatus::Ok), "{:?}", load.status);
    assert_eq!(load.loaded_from, Some(LoadedFrom::Embedded));
    assert_eq!(b.count(&id), 3);
    let loaded = b.inner().dataset(&id).unwrap();
    assert_eq!(loaded.type_overrides, overrides);
    assert_eq!(loaded.column("amount").unwrap().logical_type, LogicalType::String);
    assert_eq!(loaded.column("amount").unwrap().original_type.as_deref(), Some("DOUBLE"));
    assert_eq!(loaded.column("day").unwrap().logical_type, LogicalType::Date);
    let conn = b.inner().pool.get().unwrap();
    let (region, nulls): (String, i64) = conn
        .query_row(
            &format!("SELECT max(region) FILTER (WHERE amount = '1000.0'), count(*) - count(region) FROM dsv_{id}"),
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(region, "a,\"b");
    assert_eq!(nulls, 1);
}

#[test]
fn linked_resolves_relative_before_absolute() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("orig");
    let csv = original.join("data/sales.csv");
    write_csv(&csv, SALES);
    let a = Env::new();
    let id = a.import(&csv);
    save_project(a.inner(), &a.session, &original.join("p.datacanvas"), StorageMode::Linked, doc()).unwrap();

    // Move the whole folder (project + data) somewhere else; a different file stays at the old absolute path.
    let moved = dir.path().join("moved");
    write_csv(&moved.join("data/sales.csv"), "region,amount\nWest,1\nWest,2\nWest,3\nWest,4\n");
    fs::copy(original.join("p.datacanvas"), moved.join("p.datacanvas")).unwrap();
    // The moved copy differs, so change detection must flag it; what matters is which file was read.
    let b = Env::new();
    let opened = open_project(b.inner(), &b.session, &moved.join("p.datacanvas")).unwrap();
    let meta = opened.datasets[0].meta.clone().unwrap();
    assert_eq!(PathBuf::from(&meta.source.path), moved.join("data/sales.csv"));
    assert_eq!(b.count(&id), 4);

    // Without the relative file, the absolute path is used.
    fs::remove_file(moved.join("data/sales.csv")).unwrap();
    let c = Env::new();
    let opened = open_project(c.inner(), &c.session, &moved.join("p.datacanvas")).unwrap();
    assert!(matches!(opened.datasets[0].status, LoadStatus::Ok));
    assert_eq!(c.count(&id), 3);
}

#[test]
fn missing_source_is_kept_and_can_be_relocated() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let project = dir.path().join("p.datacanvas");
    let a = Env::new();
    let id = a.import(&csv);
    save_project(a.inner(), &a.session, &project, StorageMode::Linked, doc()).unwrap();
    let elsewhere = dir.path().join("archive/sales-final.csv");
    write_csv(&elsewhere, SALES);
    fs::remove_file(&csv).unwrap();

    let b = Env::new();
    let opened = open_project(b.inner(), &b.session, &project).unwrap();
    match &opened.datasets[0].status {
        LoadStatus::Missing { searched } => assert!(searched.contains(&csv.display().to_string())),
        s => panic!("expected missing, got {s:?}"),
    }
    assert!(b.inner().dataset(&id).is_err());

    // Saving without relocating keeps the dataset entry.
    save_project(b.inner(), &b.session, &project, StorageMode::Linked, doc()).unwrap();
    assert_eq!(read_json(&project, PROJECT_ENTRY)["datasets"].as_array().unwrap().len(), 1);
    assert!(matches!(reload_dataset(b.inner(), &b.session, &id), Err(AppError::FileNotFound(_))));

    let load = relocate_dataset(b.inner(), &b.session, &id, &elsewhere).unwrap();
    assert!(matches!(load.status, LoadStatus::Ok), "{:?}", load.status);
    assert_eq!(b.count(&id), 3);
    assert!(b.session.unresolved.lock().unwrap().is_empty());
    save_project(b.inner(), &b.session, &project, StorageMode::Linked, doc()).unwrap();
    let body = read_json(&project, PROJECT_ENTRY);
    assert_eq!(body["datasets"][0]["source"]["path"], elsewhere.display().to_string());
    assert_eq!(body["datasets"][0]["relativePath"], "archive/sales-final.csv");
}

#[test]
fn detects_fingerprint_and_schema_changes() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let project = dir.path().join("p.datacanvas");
    let a = Env::new();
    let id = a.import(&csv);
    let saved_fp = a.inner().dataset(&id).unwrap().fingerprint;
    save_project(a.inner(), &a.session, &project, StorageMode::Linked, doc()).unwrap();

    write_csv(&csv, "region,amount,units\nNorth,10,1\nSouth,20,2\nEast,30,3\nWest,40,4\n");
    let b = Env::new();
    let opened = open_project(b.inner(), &b.session, &project).unwrap();
    let change = match &opened.datasets[0].status {
        LoadStatus::Changed { change } => change.clone(),
        s => panic!("expected changed, got {s:?}"),
    };
    assert!(change.fingerprint_changed);
    let schema = change.schema.unwrap();
    assert_eq!(schema.added, vec!["units"]);
    assert!(schema.removed.is_empty());
    assert_eq!((schema.row_count_before, schema.row_count_after), (3, 4));
    // "Keep": the project still records the saved fingerprint, while queries see the current file.
    assert_eq!(b.inner().dataset(&id).unwrap().fingerprint, saved_fp);
    assert_eq!(b.count(&id), 4);

    // "Refresh": adopt the new fingerprint.
    let load = reload_dataset(b.inner(), &b.session, &id).unwrap();
    assert!(matches!(load.status, LoadStatus::Changed { .. }));
    assert_ne!(b.inner().dataset(&id).unwrap().fingerprint.partial_sha256, saved_fp.partial_sha256);
    save_project(b.inner(), &b.session, &project, StorageMode::Linked, doc()).unwrap();
    let c = Env::new();
    let reopened = open_project(c.inner(), &c.session, &project).unwrap();
    assert!(matches!(reopened.datasets[0].status, LoadStatus::Ok));

    // Unchanged content with a new mtime is not a change.
    let bytes = fs::read(&csv).unwrap();
    fs::remove_file(&csv).unwrap();
    fs::write(&csv, bytes).unwrap();
    let d = Env::new();
    assert!(matches!(open_project(d.inner(), &d.session, &project).unwrap().datasets[0].status, LoadStatus::Ok));
}

#[test]
fn portable_flags_changed_source_but_uses_embedded_copy() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let project = dir.path().join("p.datacanvas");
    let a = Env::new();
    let id = a.import(&csv);
    save_project(a.inner(), &a.session, &project, StorageMode::Portable, doc()).unwrap();
    write_csv(&csv, "region,amount\nNorth,10\n");

    let b = Env::new();
    let opened = open_project(b.inner(), &b.session, &project).unwrap();
    assert!(matches!(opened.datasets[0].status, LoadStatus::Changed { .. }));
    assert_eq!(opened.datasets[0].loaded_from, Some(LoadedFrom::Embedded));
    assert_eq!(b.count(&id), 3);
    reload_dataset(b.inner(), &b.session, &id).unwrap();
    assert_eq!(b.count(&id), 1);
}

fn write_raw_zip(path: &Path, manifest: &Value, body: &Value) {
    let mut zip = ZipWriter::new(File::create(path).unwrap());
    zip.start_file(MANIFEST_ENTRY, SimpleFileOptions::default()).unwrap();
    zip.write_all(manifest.to_string().as_bytes()).unwrap();
    zip.start_file(PROJECT_ENTRY, SimpleFileOptions::default()).unwrap();
    zip.write_all(body.to_string().as_bytes()).unwrap();
    zip.finish().unwrap();
}

#[test]
fn migrates_draft_format_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let a = Env::new();
    let id = a.import(&csv);
    let meta = serde_json::to_value(a.inner().dataset(&id).unwrap()).unwrap();

    let project = dir.path().join("old.datacanvas");
    write_raw_zip(&project, &json!({ "appVersion": "0.0.1" }), &json!({ "doc": doc(), "datasets": [meta] }));
    let b = Env::new();
    let opened = open_project(b.inner(), &b.session, &project).unwrap();
    assert_eq!(opened.migrated_from, Some(0));
    assert_eq!(opened.project, doc());
    assert!(matches!(opened.datasets[0].status, LoadStatus::Ok));
    assert_eq!(b.count(&id), 3);
}

#[test]
fn newer_or_corrupt_files_leave_session_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let a = Env::new();
    let id = a.import(&csv);

    let newer = dir.path().join("newer.datacanvas");
    write_raw_zip(
        &newer,
        &json!({ "formatVersion": FORMAT_VERSION + 1, "appVersion": "9.0.0" }),
        &json!({ "mode": "linked", "project": {}, "datasets": [] }),
    );
    let err = open_project(a.inner(), &a.session, &newer).err().unwrap();
    assert!(err.to_string().contains("newer"), "{err}");

    let junk = dir.path().join("junk.datacanvas");
    fs::write(&junk, b"not a zip").unwrap();
    assert!(matches!(open_project(a.inner(), &a.session, &junk), Err(AppError::UnsupportedFile(_))));
    assert!(a.inner().dataset(&id).is_ok());
}

#[test]
fn save_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let project = dir.path().join("p.datacanvas");
    let a = Env::new();
    let id = a.import(&csv);
    save_project(a.inner(), &a.session, &project, StorageMode::Linked, doc()).unwrap();
    let before = fs::read(&project).unwrap();

    // Failure after manifest.json and project.json are already in the temp zip.
    let body = crate::project::format::ProjectJson {
        mode: StorageMode::Portable,
        saved_at: String::new(),
        project: doc(),
        datasets: vec![],
    };
    let missing = dir.path().join("vanished.parquet");
    let r = crate::project::format::write_archive(&project, &body, &[("data/x.parquet".into(), missing)]);
    assert!(r.is_err());
    assert_eq!(fs::read(&project).unwrap(), before);

    // Portable save fails while exporting (the table is gone).
    a.inner().pool.get().unwrap().execute_batch(&format!("DROP VIEW dsv_{id}; DROP TABLE ds_{id};")).unwrap();
    assert!(save_project(a.inner(), &a.session, &project, StorageMode::Portable, doc()).is_err());
    assert_eq!(fs::read(&project).unwrap(), before);
    let leftovers: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());

    assert!(save_project(a.inner(), &a.session, &dir.path().join("nope/p.datacanvas"), StorageMode::Linked, doc()).is_err());
}

#[test]
fn recovery_snapshot_restores_unsaved_work() {
    let dir = tempfile::tempdir().unwrap();
    let rec = dir.path().join("recovery");
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let a = Env::new();
    let id = a.import(&csv);
    write_recovery(a.inner(), &a.session, &rec, "pr_test1", StorageMode::Linked, doc()).unwrap();
    assert!(rec.join("pr_test1.json").is_file());
    let summaries = crate::project::recovery::list(&rec).unwrap();
    assert_eq!(summaries[0].name, "Sales review");
    assert_eq!(summaries[0].dataset_count, 1);

    // Simulated crash: fresh process restores from the snapshot.
    let b = Env::new();
    let restored = restore_recovery(b.inner(), &b.session, &rec, "pr_test1").unwrap();
    assert_eq!(restored.project, doc());
    assert_eq!(restored.path, None);
    assert_eq!(b.count(&id), 3);

    // An exit the user never confirmed (Dock quit, logout, crash) keeps the snapshot.
    *a.session.recovery_dir.lock().unwrap() = Some(rec.clone());
    cleanup_recovery_on_exit(&a.session);
    assert!(rec.join("pr_test1.json").is_file());

    // Confirmed quit removes the snapshots this process wrote, and late autosaves are dropped.
    a.session.confirm_exit();
    cleanup_recovery_on_exit(&a.session);
    assert!(!rec.join("pr_test1.json").exists());
    write_recovery(a.inner(), &a.session, &rec, "pr_test1", StorageMode::Linked, doc()).unwrap();
    assert!(!rec.join("pr_test1.json").exists());
}

#[test]
fn recovery_falls_back_to_saved_parquet() {
    let dir = tempfile::tempdir().unwrap();
    let rec = dir.path().join("recovery");
    let csv = dir.path().join("sales.csv");
    write_csv(&csv, SALES);
    let project = dir.path().join("p.datacanvas");
    let a = Env::new();
    let id = a.import(&csv);
    save_project(a.inner(), &a.session, &project, StorageMode::Portable, doc()).unwrap();
    write_recovery(a.inner(), &a.session, &rec, "pr_test1", StorageMode::Portable, doc()).unwrap();
    fs::remove_file(&csv).unwrap();

    let b = Env::new();
    let restored = restore_recovery(b.inner(), &b.session, &rec, "pr_test1").unwrap();
    assert_eq!(restored.path, Some(project.display().to_string()));
    assert_eq!(restored.datasets[0].loaded_from, Some(LoadedFrom::Embedded));
    assert_eq!(b.count(&id), 3);
}
