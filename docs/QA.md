# DataCanvas Desktop: manual QA checklist

Run this checklist on **macOS** (Apple Silicon and, if available, Intel) and **Windows 10/11**
before publishing a release. Use the installers produced by the
[release workflow](../.github/workflows/release.yml) (draft release artifacts), not `tauri dev`.

Record results in the release PR as `OS / build / pass|fail / notes`.

Sample files: `src-tauri/tests/fixtures/` has `multi_sheet.xlsx` (sheets Sales, Targets, and an
empty Notes sheet), `malformed.csv` (one row with extra fields) and `malformed.xlsx` (a truncated
archive). For a large file, generate about 1M rows:

```sh
python3 -c "import random;print('id,order_date,region,amount');[print(f'{i},2025-{1+i//28%12:02}-{1+i%28:02},{random.choice([\"North\",\"South\",\"East\",\"West\"])},{i%100}') for i in range(1_000_000)]" > large.csv
```

## 1. Install and launch

| Step | macOS (`.dmg`, universal) | Windows (`.exe` NSIS and `.msi`) |
| --- | --- | --- |
| Install | Open the dmg and drag DataCanvas to Applications | Run the NSIS installer; separately, on a clean VM, run the MSI |
| Unsigned build warning | Gatekeeper blocks the first launch: right-click > Open. With signing secrets set: no warning, and `spctl -a -vv /Applications/DataCanvas.app` reports "Notarized Developer ID" | SmartScreen "Windows protected your PC": More info > Run anyway. With a certificate: the publisher name is shown |
| Architecture | `lipo -archs /Applications/DataCanvas.app/Contents/MacOS/datacanvas` prints `x86_64 arm64` | n/a |
| WebView | n/a | On a machine without WebView2, the installer installs it (embedded bootstrapper) |
| First launch | Window opens at 1360x860 and the Home screen shows no recent projects | Same |
| Window state | Resize and move the window, quit, relaunch: size and position are restored | Same |

## 2. Native dialogs

- [ ] File > Open (Cmd/Ctrl+O) shows the native open dialog filtered to `.datacanvas`.
- [ ] File > Import Data (Cmd/Ctrl+I) shows the native dialog filtered to CSV and Excel.
- [ ] File > Save As (Cmd/Ctrl+Shift+S) shows the native save dialog. A name typed without an
      extension is saved as `<name>.datacanvas`.
- [ ] Cancelling any dialog does nothing and shows no error.
- [ ] The "unsaved changes" confirmation is a native dialog, not a browser `confirm()`.
- [ ] PNG, PDF and CSV exports open a native save dialog with the right extension.

## 3. Drag and drop from Finder or Explorer

- [ ] Dragging a CSV over the window shows the "Drop to import" overlay. Dropping it opens the
      import dialog with the file preselected.
- [ ] Dropping `multi_sheet.xlsx` offers the sheets Sales, Targets and Notes. Importing Notes
      shows an "empty sheet" error.
- [ ] Dropping a `.datacanvas` file opens the project (and asks first if there are unsaved changes).
- [ ] Dropping an unsupported file (for example a `.png`) shows "Unsupported file".
- [ ] Dropping several files imports the first one and shows a "one file at a time" toast.
- [ ] Moving the pointer away from the window without dropping clears the overlay.

## 4. File association (`.datacanvas`)

- [ ] After installing, `.datacanvas` files show the DataCanvas document type ("DataCanvas
      Project") and the app icon in Finder or Explorer.
- [ ] **App not running:** double-click a saved project. The app launches and opens it.
- [ ] **App running, no unsaved changes:** double-click another project. The window comes to the
      front and switches to that project.
- [ ] **App running with unsaved changes:** double-click a project. The app asks before
      discarding the changes, and cancelling keeps the current project.
- [ ] Windows: right-click > Open with > DataCanvas works. Note that each double-click while the
      app is running starts a second instance, because single-instance handling is not
      implemented yet. Record what happens.
- [ ] macOS: Get Info > Open with > DataCanvas > Change All… applies to every `.datacanvas` file.
- [ ] After uninstalling, the association is removed (Windows: both NSIS and MSI).

## 5. Quit and unsaved changes

- [ ] With no unsaved changes, Cmd+Q, the app menu Quit item, File > Exit (Windows) and the
      window close button all quit immediately.
- [ ] With unsaved changes, **each** of the above asks "You have unsaved changes. Quit without
      saving?":
  - [ ] Cancel: the app stays open, the changes are still there, and the recovery snapshot
        is still in the recovery folder (see section 6).
  - [ ] Confirm: the app quits, and relaunching does **not** offer recovery.
- [ ] Pressing Cmd+Q twice quickly shows only one prompt.
- [ ] macOS: quitting from the Dock (right-click > Quit), or logging out, with unsaved changes
      quits without a prompt. The next launch **offers recovery**, because the snapshot is kept
      for any exit the user did not confirm.

## 6. Recovery after a forced kill

Recovery folder:
macOS `~/Library/Application Support/com.datacanvas.desktop/recovery/`,
Windows `%APPDATA%\com.datacanvas.desktop\recovery\`.

1. Import a CSV, add two widgets and **do not save**. Wait at least 30 seconds, or about 1 second
   after the first edit.
2. Confirm that `<projectId>.json` exists in the recovery folder.
3. Kill the process:
   - macOS: `pkill -9 datacanvas`, or Activity Monitor > Force Quit.
   - Windows: Task Manager > End task, or `taskkill /F /IM datacanvas.exe`.
4. Relaunch and check:
   - [ ] A recovery dialog lists the project with its name and time.
   - [ ] Recover restores the widgets and datasets. The project is marked unsaved.
   - [ ] Discard deletes the snapshot, and it is not offered again.
   - [ ] For a project that was saved in Portable mode and whose source CSV was then deleted,
         Recover still loads the data from the saved project file.
- [ ] Saving the project removes its snapshot.

## 7. Offline mode (networking disabled)

Disable Wi-Fi and Ethernet, or block the app in the firewall (macOS: Little Snitch or LuLu;
Windows: an outbound rule in Windows Defender Firewall for `datacanvas.exe`).

- [ ] The app launches and the UI renders fully (fonts and icons included).
- [ ] CSV and XLSX import, preview, column stats, every chart type, dashboard filters,
      calculated metrics, save and open (Linked and Portable), and PNG, PDF and CSV export all work.
- [ ] Over a full session, a network monitor (Little Snitch, or Resource Monitor > Network on
      Windows) shows **no** outbound connections from DataCanvas.
- [ ] DevTools in a debug build: the console shows no CSP violations and no blocked remote
      requests.

## 8. Large data

- [ ] Import `large.csv` (about 1M rows). It finishes in a reasonable time (record it) and the UI
      stays responsive while it runs.
- [ ] The preview grid scrolls smoothly, and sorting a column returns quickly.
- [ ] A bar chart grouped by region with sum(amount) renders. Changing the date bucket on a line
      chart re-queries without freezing the UI.
- [ ] Save in Portable mode, reopen the project, and check the file size.

## 9. Malformed files

- [ ] `malformed.csv` with the default options shows a "Malformed rows" error that mentions
      "Skip malformed rows". With that option on, it imports 49 rows.
- [ ] `malformed.xlsx` shows "Unsupported file type".
- [ ] A Latin-1 CSV opened as UTF-8 shows an encoding error. Choosing latin-1 imports it.

## 10. PNG and PDF export: WKWebView vs WebView2

Export rendering goes through the platform webview (WKWebView on macOS, WebView2 on Windows),
which differ in canvas, font and compositing behaviour. Build one dashboard with a bar, a line,
a pie, a KPI card and a table widget, plus a long title. Then export from both OSes and compare
the files side by side:

- [ ] Widget PNG: correct size and pixel density (2x on Retina, the display scale on Windows),
      no clipped labels, and a transparent or white background as expected.
- [ ] Dashboard PNG (composite): every widget appears, in its grid position, with no
      blank tiles. On WebView2, widgets scrolled out of view must still render.
- [ ] PDF: one page per dashboard, fonts readable (not replaced by a fallback), and charts sharp.
- [ ] Table and KPI widgets (DOM-drawn) match the on-screen styling on both OSes.
- [ ] Non-ASCII text (for example `Zürich`, `東京`) renders in the PNG and the PDF.
- [ ] Very large dashboards (more than 20 widgets) export without running out of memory.

## 11. Menus and shortcuts

- [ ] macOS uses Cmd and Windows uses Ctrl for New, Open, Save, Save As, Import, Undo, Redo
      (Cmd/Ctrl+Shift+Z), Duplicate (with a widget selected) and Quit/Exit (Cmd/Ctrl+Q).
- [ ] Undo and redo inside a text field edit the text, not the dashboard.
- [ ] View > Home/Data/Dashboard (Cmd/Ctrl+1/2/3) switches screens.
- [ ] macOS: the app menu has About, Hide, Hide Others and Quit DataCanvas.
      Windows: File > Exit.

## 12. Web build (`pnpm build:web`)

Serve `dist-web/` with `pnpm preview:web` and test in Chrome, plus Firefox and Safari if
available. See [WEB.md](WEB.md) for the expected behaviour.

- [ ] The sidebar shows the "Web · runs in your browser" badge, and there is no Linked/Portable
      toggle and no recent projects list.
- [ ] CSV and `multi_sheet.xlsx` import (picker and drag and drop), charts, filters, metrics,
      and PNG, PDF and CSV export all work.
- [ ] Save, then reopen the saved `.datacanvas` on the web and in the desktop app. A desktop
      Portable project opens on the web.
- [ ] DevTools > Network over a full session shows only same-origin and `blob:` requests, and the
      console shows no CSP violations.
- [ ] Edit without saving and close the tab: the browser asks "Leave site?". Reopen the page:
      the recovery dialog offers the project.
- [ ] With "Reduce motion" turned on in the OS, screen transitions, chart entrances and KPI
      count-ups are instant.

## 13. Uninstall and upgrade

- [ ] Installing a newer build over an older one keeps recent projects and settings.
- [ ] Installing an older version over a newer one is refused (`allowDowngrades: false`).
- [ ] Uninstalling removes the app. User data in the app data folder is kept unless the user
      chooses otherwise (NSIS "Delete app data" checkbox).
