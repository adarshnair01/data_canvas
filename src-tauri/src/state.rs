use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use crate::db::pool::DuckPool;
use crate::db::settings::SettingsDb;
use crate::error::{AppError, AppResult};
use crate::model::DatasetMeta;

pub struct Inner {
    pub pool: DuckPool,
    pub datasets: RwLock<HashMap<String, DatasetMeta>>,
    pub settings: Mutex<Option<SettingsDb>>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

impl AppState {
    pub fn new() -> AppResult<Self> {
        Ok(Self(Arc::new(Inner {
            pool: DuckPool::in_memory()?,
            datasets: RwLock::new(HashMap::new()),
            settings: Mutex::new(None),
        })))
    }
}

impl Inner {
    pub fn dataset(&self, id: &str) -> AppResult<DatasetMeta> {
        self.datasets
            .read()
            .map_err(|_| AppError::Internal("dataset registry poisoned".into()))?
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::UnknownDataset(id.to_string()))
    }

    pub fn put_dataset(&self, meta: DatasetMeta) -> AppResult<()> {
        self.datasets
            .write()
            .map_err(|_| AppError::Internal("dataset registry poisoned".into()))?
            .insert(meta.id.clone(), meta);
        Ok(())
    }

    pub fn with_settings<T>(&self, f: impl FnOnce(&SettingsDb) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .settings
            .lock()
            .map_err(|_| AppError::Internal("settings lock poisoned".into()))?;
        match guard.as_ref() {
            Some(db) => f(db),
            None => Err(AppError::Internal("settings database not initialised".into())),
        }
    }
}

/// Run DuckDB/SQLite work on a blocking worker thread so the UI thread stays responsive.
pub async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("worker failed: {e}")))?
}
