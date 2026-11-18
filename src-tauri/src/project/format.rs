//! `.datacanvas` archive layout:
//!
//! - `manifest.json`: `{ formatVersion, appVersion }`
//! - `project.json`: storage mode, the frontend `ProjectDoc` (dashboards, widgets, layouts,
//!   global filters, calculated metrics) and every dataset with its schema, fingerprint and
//!   type-override transformations
//! - `data/<datasetId>.parquet`: Portable mode only. Projects saved by the web version embed
//!   `data/<datasetId>.csv` instead (typed by the saved column metadata); both are read.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::error::{AppError, AppResult};
use crate::model::DatasetMeta;
use crate::project::atomic::atomic_write;

pub const FORMAT_VERSION: u32 = 1;
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MANIFEST_ENTRY: &str = "manifest.json";
pub const PROJECT_ENTRY: &str = "project.json";

/// Zip entries above this size need ZIP64 headers.
const ZIP64_THRESHOLD: u64 = 0xFFFF_0000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Missing in the unversioned draft format, which is treated as version 0.
    #[serde(default)]
    pub format_version: u32,
    #[serde(default)]
    pub app_version: String,
}

impl Manifest {
    pub fn current() -> Self {
        Self {
            format_version: FORMAT_VERSION,
            app_version: APP_VERSION.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageMode {
    Linked,
    Portable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDataset {
    /// `source.path` holds the absolute path of the linked file.
    #[serde(flatten)]
    pub meta: DatasetMeta,
    /// Path relative to the project file's directory (`/`-separated), tried before `source.path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    /// Zip entry holding the Parquet copy (Portable mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedded: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectJson {
    pub mode: StorageMode,
    #[serde(default)]
    pub saved_at: String,
    /// Frontend-owned `ProjectDoc`, stored verbatim.
    pub project: Value,
    pub datasets: Vec<ProjectDataset>,
}

pub fn embedded_entry(dataset_id: &str) -> String {
    format!("data/{dataset_id}.parquet")
}

fn invalid(msg: impl std::fmt::Display) -> AppError {
    AppError::UnsupportedFile(format!("not a valid DataCanvas project: {msg}"))
}

fn zip_err(e: zip::result::ZipError) -> AppError {
    match e {
        zip::result::ZipError::Io(io) => AppError::from(io),
        other => invalid(other),
    }
}

// ---------------------------------------------------------------------------------------------
// Migrations

/// Upgrade a `project.json` value written with `from` to the current format.
/// Each step takes version N to N+1, so old files are carried forward one version at a time.
pub fn migrate(mut project: Value, from: u32) -> AppResult<Value> {
    if from > FORMAT_VERSION {
        return Err(AppError::UnsupportedFile(format!(
            "this project was saved by a newer DataCanvas (format {from}); this build reads format {FORMAT_VERSION} and older"
        )));
    }
    for version in from..FORMAT_VERSION {
        project = match version {
            0 => v0_to_v1(project)?,
            v => return Err(invalid(format!("no migration from format {v}"))),
        };
    }
    Ok(project)
}

/// Draft format 0: the doc lived under `doc`, there was no storage mode (always linked)
/// and datasets carried only absolute paths.
fn v0_to_v1(mut v: Value) -> AppResult<Value> {
    let obj = v.as_object_mut().ok_or_else(|| invalid("project.json is not an object"))?;
    if let Some(doc) = obj.remove("doc") {
        obj.entry("project").or_insert(doc);
    }
    obj.entry("mode").or_insert_with(|| Value::String("linked".into()));
    obj.entry("savedAt").or_insert_with(|| Value::String(String::new()));
    obj.entry("datasets").or_insert_with(|| Value::Array(vec![]));
    Ok(v)
}

// ---------------------------------------------------------------------------------------------
// Linked paths

/// `target` relative to `base_dir`, joined with `/`. `None` when they share no root
/// (for example different Windows drives) or either path is relative.
pub fn relative_path(base_dir: &Path, target: &Path) -> Option<String> {
    if !base_dir.is_absolute() || !target.is_absolute() {
        return None;
    }
    let base: Vec<Component> = base_dir.components().collect();
    let tgt: Vec<Component> = target.components().collect();
    if base.first() != tgt.first() {
        return None;
    }
    let common = base.iter().zip(&tgt).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); base.len() - common];
    parts.extend(tgt[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    Some(parts.join("/"))
}

/// Candidate locations for a linked dataset, in resolution order: relative first, then absolute.
pub fn candidate_paths(project_dir: Option<&Path>, ds: &ProjectDataset) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let (Some(dir), Some(rel)) = (project_dir, ds.relative_path.as_deref()) {
        out.push(dir.join(rel));
    }
    let abs = PathBuf::from(&ds.meta.source.path);
    if !out.contains(&abs) {
        out.push(abs);
    }
    out
}

pub fn resolve_source(project_dir: Option<&Path>, ds: &ProjectDataset) -> Option<PathBuf> {
    candidate_paths(project_dir, ds).into_iter().find(|p| p.is_file())
}

// ---------------------------------------------------------------------------------------------
// Archive I/O

/// Write the archive atomically. `embedded` pairs a zip entry name with a file to copy in.
pub fn write_archive(path: &Path, project: &ProjectJson, embedded: &[(String, PathBuf)]) -> AppResult<()> {
    let manifest = serde_json::to_vec_pretty(&Manifest::current())
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let body = serde_json::to_vec_pretty(project).map_err(|e| AppError::Internal(e.to_string()))?;
    atomic_write(path, |file| {
        let mut zip = ZipWriter::new(file);
        let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file(MANIFEST_ENTRY, deflate).map_err(zip_err)?;
        zip.write_all(&manifest)?;
        zip.start_file(PROJECT_ENTRY, deflate).map_err(zip_err)?;
        zip.write_all(&body)?;
        for (entry, src) in embedded {
            let size = std::fs::metadata(src)?.len();
            // Parquet is already compressed.
            let opts = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(size >= ZIP64_THRESHOLD);
            zip.start_file(entry.as_str(), opts).map_err(zip_err)?;
            std::io::copy(&mut File::open(src)?, &mut zip)?;
        }
        zip.finish().map_err(zip_err)?;
        Ok(())
    })
}

pub struct LoadedArchive {
    pub manifest: Manifest,
    pub project: ProjectJson,
    /// Set when the file was upgraded from an older format.
    pub migrated_from: Option<u32>,
}

fn read_entry(zip: &mut ZipArchive<File>, name: &str) -> AppResult<Vec<u8>> {
    let mut f = zip.by_name(name).map_err(|_| invalid(format!("missing {name}")))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

pub fn read_archive(path: &Path) -> AppResult<LoadedArchive> {
    let file = File::open(path).map_err(|_| AppError::FileNotFound(path.display().to_string()))?;
    let mut zip = ZipArchive::new(file).map_err(zip_err)?;
    let manifest: Manifest = serde_json::from_slice(&read_entry(&mut zip, MANIFEST_ENTRY)?)
        .map_err(|e| invalid(format!("manifest.json: {e}")))?;
    let raw: Value = serde_json::from_slice(&read_entry(&mut zip, PROJECT_ENTRY)?)
        .map_err(|e| invalid(format!("project.json: {e}")))?;
    let migrated = migrate(raw, manifest.format_version)?;
    let project: ProjectJson =
        serde_json::from_value(migrated).map_err(|e| invalid(format!("project.json: {e}")))?;
    let migrated_from = (manifest.format_version < FORMAT_VERSION).then_some(manifest.format_version);
    Ok(LoadedArchive {
        manifest,
        project,
        migrated_from,
    })
}

pub fn has_entry(path: &Path, entry: &str) -> bool {
    File::open(path)
        .ok()
        .and_then(|f| ZipArchive::new(f).ok())
        .is_some_and(|z| z.index_for_name(entry).is_some())
}

/// Copy one archive entry to `dest` (DuckDB reads Parquet from a real file, not from the zip).
pub fn extract_entry(path: &Path, entry: &str, dest: &Path) -> AppResult<()> {
    let file = File::open(path)?;
    let mut zip = ZipArchive::new(file).map_err(zip_err)?;
    let mut src = zip.by_name(entry).map_err(|_| invalid(format!("missing {entry}")))?;
    let mut out = File::create(dest)?;
    std::io::copy(&mut src, &mut out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relative_paths() {
        let base = Path::new("/Users/a/projects");
        assert_eq!(relative_path(base, Path::new("/Users/a/projects/data/x.csv")).unwrap(), "data/x.csv");
        assert_eq!(relative_path(base, Path::new("/Users/a/data/x.csv")).unwrap(), "../data/x.csv");
        assert_eq!(relative_path(base, Path::new("/tmp/x.csv")).unwrap(), "../../../tmp/x.csv");
        assert!(relative_path(Path::new("rel"), Path::new("/tmp/x.csv")).is_none());
    }

    #[test]
    fn migrates_draft_format() {
        let v0 = json!({ "doc": { "id": "pr1", "name": "Old" }, "datasets": [] });
        let v1 = migrate(v0, 0).unwrap();
        assert_eq!(v1["project"]["name"], "Old");
        assert_eq!(v1["mode"], "linked");
        assert!(v1.get("doc").is_none());
        let parsed: ProjectJson = serde_json::from_value(v1).unwrap();
        assert_eq!(parsed.mode, StorageMode::Linked);
    }

    #[test]
    fn current_format_is_untouched_and_newer_is_rejected() {
        let v = json!({ "mode": "portable", "project": {}, "datasets": [] });
        assert_eq!(migrate(v.clone(), FORMAT_VERSION).unwrap(), v);
        let err = migrate(v, FORMAT_VERSION + 1).unwrap_err();
        assert!(err.to_string().contains("newer"), "{err}");
    }

    #[test]
    fn manifest_without_version_is_draft() {
        let m: Manifest = serde_json::from_str(r#"{"appVersion":"0.0.1"}"#).unwrap();
        assert_eq!(m.format_version, 0);
    }
}
