# DataCanvas Web

The web build runs DataCanvas entirely in the browser. DuckDB runs as WebAssembly
([DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview)) in a worker inside the tab. There is
no server: files you import are read locally and never uploaded.

## Run and build

```sh
pnpm dev:web      # dev server on http://localhost:5180
pnpm build:web    # static site in dist-web/
pnpm preview:web  # serve dist-web/ on http://localhost:5181 (with the production CSP)
```

`dist-web/` is a plain static site with relative asset paths, so it can be served from any static
host or sub-path (for example `python3 -m http.server -d dist-web`). It does not work from
`file://`, because browsers do not run module workers from file URLs. The desktop build
(`pnpm build`, `pnpm tauri build`) is unchanged and does not include DuckDB-Wasm or SheetJS.

## How it fits together

The UI, stores, chart and dashboard code are shared with desktop. Only the backend differs:
`src/lib/ipc.ts` calls the Rust commands on desktop, and on web it lazy-loads
`src/lib/backend/web/`, which implements the same `Backend` interface on top of DuckDB-Wasm.
The SQL it generates comes from the same query builder, and a golden test
(`src/lib/backend/web/crosscheck.test.ts`) checks that it gives the same results as the Rust
backend on shared fixtures.

| Feature | Web behaviour |
| --- | --- |
| CSV import | Read through DuckDB-Wasm's `read_csv` with the same options as desktop |
| XLSX import | Parsed with SheetJS in the browser, then loaded into DuckDB |
| Open/import dialogs | Browser file picker, or drag and drop onto the page |
| Save project | Chromium: native save dialog (File System Access API). Other browsers: download |
| Project files | Always Portable: data is embedded as typed CSV (`data/<id>.csv`). Desktop opens these files, and web opens desktop Portable projects (Parquet is read with hyparquet) |
| Linked mode, Reload source | Linked mode is hidden. Reload source re-reads the file picked in this session (some browsers refuse if it changed on disk since). After reopening a project, data comes from the embedded copy, and Relocate asks you to pick the file again, because browsers cannot reopen a path |
| Recent projects | Hidden (browsers cannot reopen files by path) |
| Recovery | Autosave goes to IndexedDB in this browser profile. The recovery dialog appears on the next visit |
| Unsaved changes | In-app confirm dialog, plus the browser's "Leave site?" prompt when closing the tab |
| PNG, PDF, CSV export | Same renderer as desktop. Saved through the save dialog or as a download |
| Keyboard shortcuts | Same as desktop, except those the browser reserves (for example Cmd/Ctrl+N and W in Chrome) |
| Cancel a running query | Not supported. The query finishes in the background |

A "Web · runs in your browser" badge in the sidebar marks the mode.

## Privacy and security

- The production CSP allows only the page's own origin plus `blob:` (workers) and
  `'wasm-unsafe-eval'` (WebAssembly compilation). No remote origins are allowed, so the app cannot
  make network requests to other sites.
- DuckDB extensions are never loaded from the network. Autoinstall and autoload are off,
  community extensions are disabled, both extension repositories point at a non-existent
  `file://` path, and the configuration is then locked so queries cannot change it.
- Everything the app stores (settings, recovery snapshots) stays in this browser's local storage
  and IndexedDB. Clearing site data removes it.

## File size guidance

The data lives in the tab's memory. A WebAssembly heap is capped at 4 GB, and DuckDB needs room
for working memory as well as the table itself, so the web version suits smaller files than
desktop. These are guidelines, not measured limits:

- **CSV up to about 200 MB** (a few million rows): imports and charts should feel comfortable.
- **CSV from about 200 MB to 1 GB**: may work in Chrome or Edge on a machine with plenty of RAM,
  but expect slow imports and possible out-of-memory errors. Use the desktop app instead.
- **CSV over 1 GB**: use the desktop app.
- **XLSX up to about 50 MB**: SheetJS parses the whole workbook in memory first, so Excel files
  use much more memory than a CSV of the same size.
- Saving a project embeds every dataset as CSV, so large projects make large files and take a
  while to save.

Browser support: developed and tested in Chromium (Chrome, Edge). Firefox and Safari should work
using the download fallback for saving, but have not been tested.
