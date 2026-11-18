use tauri::State;

use crate::db::settings::RecentProject;
use crate::error::AppResult;
use crate::state::{blocking, AppState};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub async fn list_recent_projects(state: State<'_, AppState>) -> AppResult<Vec<RecentProject>> {
    let s = state.0.clone();
    blocking(move || s.with_settings(|db| db.list_recent())).await
}

#[tauri::command]
pub async fn add_recent_project(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> AppResult<Vec<RecentProject>> {
    let s = state.0.clone();
    blocking(move || {
        s.with_settings(|db| {
            db.add_recent(&path, &name, now_ms())?;
            db.list_recent()
        })
    })
    .await
}

#[tauri::command]
pub async fn remove_recent_project(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Vec<RecentProject>> {
    let s = state.0.clone();
    blocking(move || {
        s.with_settings(|db| {
            db.remove_recent(&path)?;
            db.list_recent()
        })
    })
    .await
}

#[tauri::command]
pub async fn clear_recent_projects(state: State<'_, AppState>) -> AppResult<()> {
    let s = state.0.clone();
    blocking(move || s.with_settings(|db| db.clear_recent())).await
}

#[tauri::command]
pub async fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    let s = state.0.clone();
    blocking(move || s.with_settings(|db| db.get(&key))).await
}

#[tauri::command]
pub async fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    let s = state.0.clone();
    blocking(move || s.with_settings(|db| db.set(&key, &value))).await
}
