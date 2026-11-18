use std::path::PathBuf;

use serde_json::Value;
use tauri::State;

use crate::error::AppResult;
use crate::project::datasets::DatasetLoad;
use crate::project::format::StorageMode;
use crate::project::recovery::{self, RecoverySummary};
use crate::project::service::{self, OpenedProject, SavedProject};
use crate::project::session::ProjectState;
use crate::state::{blocking, AppState};

#[tauri::command]
pub async fn save_project(
    state: State<'_, AppState>,
    project_state: State<'_, ProjectState>,
    path: String,
    mode: StorageMode,
    project: Value,
) -> AppResult<SavedProject> {
    let (s, p) = (state.0.clone(), project_state.0.clone());
    blocking(move || service::save_project(&s, &p, &PathBuf::from(path), mode, project)).await
}

#[tauri::command]
pub async fn open_project(
    state: State<'_, AppState>,
    project_state: State<'_, ProjectState>,
    path: String,
) -> AppResult<OpenedProject> {
    let (s, p) = (state.0.clone(), project_state.0.clone());
    blocking(move || service::open_project(&s, &p, &PathBuf::from(path))).await
}

#[tauri::command]
pub async fn close_project(project_state: State<'_, ProjectState>) -> AppResult<()> {
    service::close_project(&project_state.0)
}

#[tauri::command]
pub async fn reload_dataset(
    state: State<'_, AppState>,
    project_state: State<'_, ProjectState>,
    id: String,
) -> AppResult<DatasetLoad> {
    let (s, p) = (state.0.clone(), project_state.0.clone());
    blocking(move || service::reload_dataset(&s, &p, &id)).await
}

#[tauri::command]
pub async fn relocate_dataset(
    state: State<'_, AppState>,
    project_state: State<'_, ProjectState>,
    id: String,
    path: String,
) -> AppResult<DatasetLoad> {
    let (s, p) = (state.0.clone(), project_state.0.clone());
    blocking(move || service::relocate_dataset(&s, &p, &id, &PathBuf::from(path))).await
}

#[tauri::command]
pub async fn write_recovery(
    state: State<'_, AppState>,
    project_state: State<'_, ProjectState>,
    project_id: String,
    mode: StorageMode,
    project: Value,
) -> AppResult<()> {
    let (s, p) = (state.0.clone(), project_state.0.clone());
    blocking(move || {
        let dir = p.recovery_dir()?;
        service::write_recovery(&s, &p, &dir, &project_id, mode, project)
    })
    .await
}

#[tauri::command]
pub async fn list_recovery(project_state: State<'_, ProjectState>) -> AppResult<Vec<RecoverySummary>> {
    let p = project_state.0.clone();
    blocking(move || recovery::list(&p.recovery_dir()?)).await
}

#[tauri::command]
pub async fn restore_recovery(
    state: State<'_, AppState>,
    project_state: State<'_, ProjectState>,
    project_id: String,
) -> AppResult<OpenedProject> {
    let (s, p) = (state.0.clone(), project_state.0.clone());
    blocking(move || {
        let dir = p.recovery_dir()?;
        service::restore_recovery(&s, &p, &dir, &project_id)
    })
    .await
}

#[tauri::command]
pub async fn delete_recovery(project_state: State<'_, ProjectState>, project_id: String) -> AppResult<()> {
    let p = project_state.0.clone();
    blocking(move || service::delete_recovery(&p, &p.recovery_dir()?, &project_id)).await
}
