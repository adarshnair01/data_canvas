pub mod commands;
pub mod db;
pub mod error;
pub mod import;
pub mod lifecycle;
pub mod menu;
pub mod model;
pub mod project;
pub mod state;

use tauri::Manager;

use crate::db::settings::SettingsDb;
use crate::lifecycle::PendingOpen;
use crate::project::session::ProjectState;
use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new().expect("failed to start DuckDB");

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(state)
        .manage(ProjectState::default())
        .manage(PendingOpen::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let db = SettingsDb::open(&dir.join("settings.sqlite"))
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            let state = app.state::<AppState>();
            *state.0.settings.lock().expect("settings lock") = Some(db);
            let project = app.state::<ProjectState>();
            *project.0.recovery_dir.lock().expect("recovery lock") = Some(dir.join("recovery"));

            let handle = app.handle();
            app.set_menu(menu::build(handle)?)?;
            app.on_menu_event(|app, event| menu::forward(app, event.id().as_ref()));
            lifecycle::deliver_open_files(handle, lifecycle::project_paths_from_args(std::env::args()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::list_recent_projects,
            commands::settings::add_recent_project,
            commands::settings::remove_recent_project,
            commands::settings::clear_recent_projects,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::dataset::import_csv,
            commands::dataset::list_xlsx_sheets,
            commands::dataset::import_xlsx,
            commands::dataset::list_datasets,
            commands::dataset::get_dataset,
            commands::dataset::rename_dataset,
            commands::dataset::remove_dataset,
            commands::dataset::preview_dataset,
            commands::dataset::column_stats,
            commands::dataset::distinct_values,
            commands::dataset::set_column_types,
            commands::dataset::fingerprint_file,
            commands::query::run_query,
            commands::query::cancel_query,
            commands::query::parse_metric_expression,
            commands::export::export_dataset_csv,
            commands::export::export_query_csv,
            commands::export::write_export_file,
            commands::project::save_project,
            commands::project::open_project,
            commands::project::close_project,
            commands::project::reload_dataset,
            commands::project::relocate_dataset,
            commands::project::write_recovery,
            commands::project::list_recovery,
            commands::project::restore_recovery,
            commands::project::delete_recovery,
            lifecycle::confirm_exit,
            lifecycle::take_pending_open_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(lifecycle::handle_run_event);
}
