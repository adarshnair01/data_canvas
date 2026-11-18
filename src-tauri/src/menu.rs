//! Native application menu. Item ids are forwarded to the webview as `menu` events.

use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const MENU_EVENT: &str = "menu";
/// Custom rather than `PredefinedMenuItem::quit`: on macOS the predefined item terminates
/// the app without an `ExitRequested` event, skipping the unsaved-changes prompt.
const QUIT_ID: &str = "quit";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accel: &str| {
        MenuItemBuilder::with_id(id, label)
            .accelerator(accel)
            .build(app)
    };

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New Project", "CmdOrCtrl+N")?)
        .item(&item("open", "Open…", "CmdOrCtrl+O")?)
        .separator()
        .item(&item("save", "Save", "CmdOrCtrl+S")?)
        .item(&item("save_as", "Save As…", "CmdOrCtrl+Shift+S")?)
        .separator()
        .item(&item("import", "Import Data…", "CmdOrCtrl+I")?);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(&item(QUIT_ID, "Exit", "CmdOrCtrl+Q")?);
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", "CmdOrCtrl+Z")?)
        .item(&item("redo", "Redo", "CmdOrCtrl+Shift+Z")?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&item("duplicate", "Duplicate Widget", "CmdOrCtrl+D")?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("nav_home", "Home", "CmdOrCtrl+1")?)
        .item(&item("nav_data", "Data", "CmdOrCtrl+2")?)
        .item(&item("nav_dashboard", "Dashboard", "CmdOrCtrl+3")?)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "DataCanvas")
            .item(&PredefinedMenuItem::about(app, None, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .separator()
            .item(&item(QUIT_ID, "Quit DataCanvas", "CmdOrCtrl+Q")?)
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .item(&PredefinedMenuItem::minimize(app, None)?)
            .item(&PredefinedMenuItem::fullscreen(app, None)?)
            .build()?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
    }
    #[cfg(not(target_os = "macos"))]
    {
        Menu::with_items(app, &[&file, &edit, &view])
    }
}

pub fn forward<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == QUIT_ID {
        return crate::lifecycle::request_quit(app);
    }
    let _ = app.emit(MENU_EVENT, id.to_string());
}
