//! Per-window project state that is not part of the dataset registry.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::project::format::ProjectDataset;

#[derive(Default)]
pub struct ProjectSession {
    /// File the current project was opened from or last saved to.
    pub project_path: Mutex<Option<PathBuf>>,
    /// Datasets from the project that could not be loaded (missing or unreadable source).
    /// They are written back on save so a missing file never silently drops a dataset.
    pub unresolved: Mutex<BTreeMap<String, ProjectDataset>>,
    pub recovery_dir: Mutex<Option<PathBuf>>,
    /// Recovery snapshots written by this process; deleted on clean exit.
    pub recovery_written: Mutex<HashSet<String>>,
    /// Set only after the frontend confirmed quitting. Any other exit keeps the snapshots.
    exit_confirmed: AtomicBool,
}

/// Tauri-managed handle so blocking workers can own a reference.
#[derive(Clone, Default)]
pub struct ProjectState(pub Arc<ProjectSession>);

pub fn lock<T>(m: &Mutex<T>) -> AppResult<MutexGuard<'_, T>> {
    m.lock().map_err(|_| AppError::Internal("project session lock poisoned".into()))
}

impl ProjectSession {
    pub fn project_dir(&self) -> AppResult<Option<PathBuf>> {
        Ok(lock(&self.project_path)?.as_deref().and_then(Path::parent).map(Path::to_path_buf))
    }

    pub fn recovery_dir(&self) -> AppResult<PathBuf> {
        lock(&self.recovery_dir)?
            .clone()
            .ok_or_else(|| AppError::Internal("recovery directory not initialised".into()))
    }

    pub fn confirm_exit(&self) {
        self.exit_confirmed.store(true, Ordering::SeqCst);
    }

    pub fn exit_confirmed(&self) -> bool {
        self.exit_confirmed.load(Ordering::SeqCst)
    }
}

/// Scratch directory removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> AppResult<Self> {
        let id = &uuid::Uuid::new_v4().simple().to_string()[..12];
        let dir = std::env::temp_dir().join(format!("datacanvas-{id}"));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
