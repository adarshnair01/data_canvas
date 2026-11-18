//! Project save/open/recovery orchestration over the dataset registry and the project session.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::model::DatasetMeta;
use crate::project::datasets::{self, clear_registry, load_dataset, DatasetLoad, LoadContext};
use crate::project::format::{
    candidate_paths, embedded_entry, read_archive, relative_path, write_archive, ProjectDataset,
    ProjectJson, StorageMode, FORMAT_VERSION,
};
use crate::project::recovery::{self, RecoverySnapshot};
use crate::project::session::{lock, ProjectSession, TempDir};
use crate::state::Inner;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProject {
    pub path: String,
    pub mode: StorageMode,
    pub saved_at: String,
    pub dataset_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    /// `None` for a recovered project that was never saved.
    pub path: Option<String>,
    pub mode: StorageMode,
    pub app_version: String,
    pub migrated_from: Option<u32>,
    pub project: Value,
    pub datasets: Vec<DatasetLoad>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn registered(inner: &Inner) -> AppResult<Vec<DatasetMeta>> {
    let mut list: Vec<DatasetMeta> = inner
        .datasets
        .read()
        .map_err(|_| AppError::Internal("dataset registry poisoned".into()))?
        .values()
        .cloned()
        .collect();
    list.sort_by(|a, b| a.imported_at.cmp(&b.imported_at).then(a.id.cmp(&b.id)));
    Ok(list)
}

/// Linked entries for every registered dataset plus the unresolved ones, with relative
/// paths computed against `project_dir`.
fn linked_entries(inner: &Inner, session: &ProjectSession, project_dir: Option<&Path>) -> AppResult<Vec<ProjectDataset>> {
    let rel = |p: &str| project_dir.and_then(|d| relative_path(d, Path::new(p)));
    let mut out: Vec<ProjectDataset> = registered(inner)?
        .into_iter()
        .map(|meta| ProjectDataset {
            relative_path: rel(&meta.source.path),
            meta,
            embedded: None,
        })
        .collect();
    for u in lock(&session.unresolved)?.values() {
        let mut u = u.clone();
        if let Some(r) = rel(&u.meta.source.path) {
            u.relative_path = Some(r);
        }
        u.embedded = None;
        out.push(u);
    }
    Ok(out)
}

pub fn save_project(
    inner: &Inner,
    session: &ProjectSession,
    path: &Path,
    mode: StorageMode,
    project: Value,
) -> AppResult<SavedProject> {
    let dir = path.parent();
    let mut entries = linked_entries(inner, session, dir)?;
    let scratch = TempDir::new()?;
    let mut embedded = Vec::new();
    if mode == StorageMode::Portable {
        let loaded: std::collections::HashSet<String> =
            registered(inner)?.into_iter().map(|m| m.id).collect();
        for e in entries.iter_mut().filter(|e| loaded.contains(&e.meta.id)) {
            let file = scratch.path().join(format!("{}.parquet", e.meta.id));
            datasets::export_parquet(inner, &e.meta.id, &file)?;
            let entry = embedded_entry(&e.meta.id);
            embedded.push((entry.clone(), file));
            e.embedded = Some(entry);
        }
    }
    let saved_at = now();
    let body = ProjectJson {
        mode,
        saved_at: saved_at.clone(),
        project,
        datasets: entries,
    };
    write_archive(path, &body, &embedded)?;
    *lock(&session.project_path)? = Some(path.to_path_buf());
    Ok(SavedProject {
        path: path.display().to_string(),
        mode,
        saved_at,
        dataset_count: body.datasets.len(),
    })
}

/// Replace the session with the datasets listed in `entries`.
fn load_all(
    inner: &Inner,
    session: &ProjectSession,
    entries: &[ProjectDataset],
    project_path: Option<&Path>,
    prefer_embedded: bool,
) -> AppResult<Vec<DatasetLoad>> {
    clear_registry(inner)?;
    lock(&session.unresolved)?.clear();
    let scratch = TempDir::new()?;
    let archive = project_path.filter(|p| p.is_file());
    let ctx = LoadContext {
        project_dir: project_path.and_then(Path::parent),
        archive,
        prefer_embedded,
        scratch: scratch.path(),
    };
    let mut loads = Vec::with_capacity(entries.len());
    let mut unresolved = lock(&session.unresolved)?;
    for ds in entries {
        let load = load_dataset(inner, &ctx, ds);
        if !load.is_loaded() {
            unresolved.insert(ds.meta.id.clone(), ds.clone());
        }
        loads.push(load);
    }
    Ok(loads)
}

pub fn open_project(inner: &Inner, session: &ProjectSession, path: &Path) -> AppResult<OpenedProject> {
    // Parse and migrate before touching the current session so a bad file changes nothing.
    let archive = read_archive(path)?;
    let loads = load_all(inner, session, &archive.project.datasets, Some(path), true)?;
    *lock(&session.project_path)? = Some(path.to_path_buf());
    Ok(OpenedProject {
        path: Some(path.display().to_string()),
        mode: archive.project.mode,
        app_version: archive.manifest.app_version,
        migrated_from: archive.migrated_from,
        project: archive.project.project,
        datasets: loads,
    })
}

/// Forget the current project file and unresolved datasets (New Project). Loaded datasets stay.
pub fn close_project(session: &ProjectSession) -> AppResult<()> {
    *lock(&session.project_path)? = None;
    lock(&session.unresolved)?.clear();
    Ok(())
}

fn find_dataset(inner: &Inner, session: &ProjectSession, id: &str) -> AppResult<(DatasetMeta, Option<ProjectDataset>)> {
    if let Ok(meta) = inner.dataset(id) {
        return Ok((meta, None));
    }
    let u = lock(&session.unresolved)?
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::UnknownDataset(id.to_string()))?;
    Ok((u.meta.clone(), Some(u)))
}

/// Reload source: re-read a dataset from its linked file (relative path first for datasets
/// that never loaded). Missing files surface as `fileNotFound` so the UI can offer Relocate.
pub fn reload_dataset(inner: &Inner, session: &ProjectSession, id: &str) -> AppResult<DatasetLoad> {
    let (meta, entry) = find_dataset(inner, session, id)?;
    let dir = session.project_dir()?;
    let candidates: Vec<PathBuf> = match &entry {
        Some(e) => candidate_paths(dir.as_deref(), e),
        None => vec![PathBuf::from(&meta.source.path)],
    };
    let path = candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| AppError::FileNotFound(meta.source.path.clone()))?;
    let load = datasets::refresh_from(inner, &meta, &path)?;
    lock(&session.unresolved)?.remove(id);
    Ok(load)
}

/// Point a dataset at a new file (missing source, or the user picked a replacement).
pub fn relocate_dataset(inner: &Inner, session: &ProjectSession, id: &str, path: &Path) -> AppResult<DatasetLoad> {
    let (meta, _) = find_dataset(inner, session, id)?;
    let load = datasets::refresh_from(inner, &meta, path)?;
    lock(&session.unresolved)?.remove(id);
    Ok(load)
}

pub fn write_recovery(
    inner: &Inner,
    session: &ProjectSession,
    dir: &Path,
    project_id: &str,
    mode: StorageMode,
    project: Value,
) -> AppResult<()> {
    // An autosave racing a confirmed quit must not leave a snapshot behind.
    if session.exit_confirmed() {
        return Ok(());
    }
    let project_path = lock(&session.project_path)?.clone();
    let mut entries = linked_entries(inner, session, project_path.as_deref().and_then(Path::parent))?;
    if project_path.is_some() {
        // Lets recovery fall back to the last saved Parquet copy when the source is gone.
        for e in &mut entries {
            e.embedded = Some(embedded_entry(&e.meta.id));
        }
    }
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Untitled project")
        .to_string();
    let snap = RecoverySnapshot {
        format_version: FORMAT_VERSION,
        project_id: project_id.to_string(),
        project_path: project_path.map(|p| p.display().to_string()),
        name,
        saved_at: now(),
        mode,
        project,
        datasets: entries,
    };
    recovery::write(dir, &snap)?;
    lock(&session.recovery_written)?.insert(project_id.to_string());
    Ok(())
}

pub fn restore_recovery(inner: &Inner, session: &ProjectSession, dir: &Path, project_id: &str) -> AppResult<OpenedProject> {
    let snap = recovery::read(dir, project_id)?;
    let project_path = snap.project_path.as_deref().map(PathBuf::from);
    let loads = load_all(inner, session, &snap.datasets, project_path.as_deref(), false)?;
    *lock(&session.project_path)? = project_path.filter(|p| p.is_file());
    Ok(OpenedProject {
        path: lock(&session.project_path)?.as_ref().map(|p| p.display().to_string()),
        mode: snap.mode,
        app_version: crate::project::format::APP_VERSION.to_string(),
        migrated_from: None,
        project: snap.project,
        datasets: loads,
    })
}

pub fn delete_recovery(session: &ProjectSession, dir: &Path, project_id: &str) -> AppResult<()> {
    recovery::delete(dir, project_id)?;
    lock(&session.recovery_written)?.remove(project_id);
    Ok(())
}

/// Event-loop exit: remove the snapshots this process wrote, but only when the user confirmed
/// quitting. Exits that bypass the prompt (Dock quit, logout, crash) keep them for recovery.
pub fn cleanup_recovery_on_exit(session: &ProjectSession) {
    if !session.exit_confirmed() {
        return;
    }
    let Ok(dir) = session.recovery_dir() else { return };
    let Ok(ids) = lock(&session.recovery_written).map(|s| s.clone()) else { return };
    for id in ids {
        let _ = recovery::delete(&dir, &id);
    }
}
