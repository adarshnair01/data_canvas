//! App lifecycle: quit requests that must go through the frontend's unsaved-changes prompt,
//! and `.datacanvas` files handed to the app by the OS (file association / "Open With").

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State};

use crate::project::service::cleanup_recovery_on_exit;
use crate::project::session::ProjectState;

pub const QUIT_REQUESTED_EVENT: &str = "quit-requested";
pub const OPEN_FILES_EVENT: &str = "open-files";
pub const MAIN_WINDOW: &str = "main";
const PROJECT_EXTENSION: &str = "datacanvas";

/// Files opened by the OS before the frontend was listening, drained once it is ready.
#[derive(Default)]
pub struct PendingOpen(Mutex<PendingInner>);

#[derive(Default)]
struct PendingInner {
    ready: bool,
    paths: Vec<String>,
}

pub fn is_project_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(PROJECT_EXTENSION))
}

/// Project files among process arguments (Windows/Linux pass the double-clicked file as argv).
pub fn project_paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .filter(|p| is_project_file(p))
        .map(|p| p.display().to_string())
        .collect()
}

/// Queue paths until the frontend is ready, then deliver them as an event.
pub fn deliver_open_files<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let pending = app.state::<PendingOpen>();
    let Ok(mut inner) = pending.0.lock() else { return };
    if inner.ready {
        drop(inner);
        focus_main(app);
        let _ = app.emit_to(MAIN_WINDOW, OPEN_FILES_EVENT, paths);
    } else {
        inner.paths.extend(paths);
    }
}

fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Quit menu item, Cmd+Q, or an exit request: ask the frontend, which confirms unsaved
/// changes and then calls `confirm_exit`.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    if app.state::<ProjectState>().0.exit_confirmed() {
        app.exit(0);
        return;
    }
    if app.get_webview_window(MAIN_WINDOW).is_none() {
        // Nobody can answer; exiting unconfirmed keeps any recovery snapshots.
        app.exit(0);
        return;
    }
    focus_main(app);
    let _ = app.emit_to(MAIN_WINDOW, QUIT_REQUESTED_EVENT, ());
}

pub fn handle_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, code, .. } => {
            let confirmed = app.state::<ProjectState>().0.exit_confirmed();
            let restarting = code == Some(tauri::RESTART_EXIT_CODE);
            if !confirmed && !restarting && app.get_webview_window(MAIN_WINDOW).is_some() {
                api.prevent_exit();
                request_quit(app);
            }
        }
        RunEvent::Exit => cleanup_recovery_on_exit(&app.state::<ProjectState>().0),
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            let paths = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .filter(|p| is_project_file(p))
                .map(|p| p.display().to_string())
                .collect();
            deliver_open_files(app, paths);
        }
        _ => {}
    }
}

/// The frontend confirmed quitting (no unsaved changes, or the user chose to discard them).
#[tauri::command]
pub fn confirm_exit<R: Runtime>(app: AppHandle<R>, project_state: State<'_, ProjectState>) {
    project_state.0.confirm_exit();
    app.exit(0);
}

/// Called once at frontend startup: returns files opened before it was ready and switches
/// later opens to `open-files` events.
#[tauri::command]
pub fn take_pending_open_files(pending: State<'_, PendingOpen>) -> Vec<String> {
    let Ok(mut inner) = pending.0.lock() else { return vec![] };
    inner.ready = true;
    std::mem::take(&mut inner.paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn picks_project_files_from_argv() {
        let got = project_paths_from_args(args(&[
            "C:\\Program Files\\DataCanvas\\datacanvas.exe",
            "--flag",
            "C:\\Users\\me\\Q3 Review.DataCanvas",
            "C:\\Users\\me\\sales.csv",
        ]));
        assert_eq!(got, vec!["C:\\Users\\me\\Q3 Review.DataCanvas".to_string()]);
        assert!(project_paths_from_args(args(&["/Applications/DataCanvas"])).is_empty());
    }

    #[test]
    fn recognises_extension_case_insensitively() {
        assert!(is_project_file(Path::new("/a/b.datacanvas")));
        assert!(is_project_file(Path::new("/a/b.DATACANVAS")));
        assert!(!is_project_file(Path::new("/a/datacanvas")));
        assert!(!is_project_file(Path::new("/a/b.datacanvas.json")));
    }
}
