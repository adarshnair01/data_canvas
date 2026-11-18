//! Autosave snapshots in `appDataDir/recovery/<projectId>.json`. A snapshot that survives
//! until the next launch means the previous session did not exit cleanly.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::project::atomic::atomic_write_bytes;
use crate::project::format::{ProjectDataset, StorageMode, FORMAT_VERSION};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    pub format_version: u32,
    pub project_id: String,
    /// Project file this session was opened from or saved to, if any.
    pub project_path: Option<String>,
    pub name: String,
    pub saved_at: String,
    pub mode: StorageMode,
    pub project: Value,
    pub datasets: Vec<ProjectDataset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    pub project_id: String,
    pub project_path: Option<String>,
    pub name: String,
    pub saved_at: String,
    pub dataset_count: usize,
}

pub fn validate_project_id(id: &str) -> AppResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(AppError::Internal(format!("invalid project id '{id}'")))
    }
}

fn snapshot_path(dir: &Path, project_id: &str) -> AppResult<PathBuf> {
    validate_project_id(project_id)?;
    Ok(dir.join(format!("{project_id}.json")))
}

pub fn write(dir: &Path, snapshot: &RecoverySnapshot) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec(snapshot).map_err(|e| AppError::Internal(e.to_string()))?;
    atomic_write_bytes(&snapshot_path(dir, &snapshot.project_id)?, &bytes)
}

pub fn read(dir: &Path, project_id: &str) -> AppResult<RecoverySnapshot> {
    let bytes = std::fs::read(snapshot_path(dir, project_id)?)?;
    let snap: RecoverySnapshot = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::UnsupportedFile(format!("recovery snapshot is unreadable: {e}")))?;
    if snap.format_version > FORMAT_VERSION {
        return Err(AppError::UnsupportedFile(
            "recovery snapshot was written by a newer DataCanvas".into(),
        ));
    }
    Ok(snap)
}

pub fn delete(dir: &Path, project_id: &str) -> AppResult<()> {
    match std::fs::remove_file(snapshot_path(dir, project_id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Snapshots on disk, newest first. Unreadable files are skipped.
pub fn list(dir: &Path) -> AppResult<Vec<RecoverySummary>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    let mut out: Vec<RecoverySummary> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".json")?.to_string();
            let snap = read(dir, &id).ok()?;
            Some(RecoverySummary {
                project_id: snap.project_id,
                project_path: snap.project_path,
                name: snap.name,
                saved_at: snap.saved_at,
                dataset_count: snap.datasets.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snap(id: &str, at: &str) -> RecoverySnapshot {
        RecoverySnapshot {
            format_version: FORMAT_VERSION,
            project_id: id.into(),
            project_path: None,
            name: format!("P {id}"),
            saved_at: at.into(),
            mode: StorageMode::Linked,
            project: json!({ "id": id }),
            datasets: vec![],
        }
    }

    #[test]
    fn write_list_read_delete() {
        let dir = tempfile::tempdir().unwrap();
        let rec = dir.path().join("recovery");
        assert!(list(&rec).unwrap().is_empty());
        write(&rec, &snap("pr_a", "2026-01-01T00:00:00Z")).unwrap();
        write(&rec, &snap("pr_b", "2026-01-02T00:00:00Z")).unwrap();
        std::fs::write(rec.join("junk.json"), "not json").unwrap();
        let ids: Vec<_> = list(&rec).unwrap().into_iter().map(|s| s.project_id).collect();
        assert_eq!(ids, vec!["pr_b", "pr_a"]);
        assert_eq!(read(&rec, "pr_a").unwrap().project["id"], "pr_a");
        delete(&rec, "pr_a").unwrap();
        delete(&rec, "pr_a").unwrap();
        assert_eq!(list(&rec).unwrap().len(), 1);
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write(dir.path(), &snap("../evil", "x")).is_err());
        assert!(read(dir.path(), "a/b").is_err());
    }
}
