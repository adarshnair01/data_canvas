# DataCanvas

Turn CSV and Excel files into interactive charts and dashboards, with no server and no upload.

**Try it in your browser: [adarshnair.online/data_canvas](https://adarshnair.online/data_canvas/)**

DataCanvas is a drag-and-drop data visualization tool built on [DuckDB](https://duckdb.org). It
ships as a desktop app (macOS and Windows, via [Tauri](https://tauri.app)) and as a web app that
runs entirely in the browser using DuckDB-Wasm. In both versions your data stays on your machine.

## Features

- **Import CSV and Excel.** Drag a file onto the window or use the file picker. Excel workbooks
  let you choose a sheet. Column types are detected automatically and can be adjusted.
- **Build charts by dragging fields.** Drop dimensions and measures onto the X axis, Y axis,
  color and size zones. Chart types: bar, line, area, pie/donut, scatter, KPI card and table.
- **Aggregate or show raw rows,** with per-widget filters.
- **Calculated metrics.** Define new measures with expressions over your columns.
- **Dashboards.** Arrange widgets on a grid and apply global filters across every chart.
- **Export** dashboards and charts to PNG and PDF, and query results to CSV.
- **Projects.** Save your work as a `.datacanvas` file. Autosave and crash recovery are built in.
- **Light and dark themes** that follow your system setting.

## Web vs desktop

| | Web | Desktop |
| --- | --- | --- |
| Engine | DuckDB-Wasm in a browser worker | Native DuckDB (Rust) |
| Comfortable file size | CSV up to ~200 MB, XLSX up to ~50 MB | Much larger (limited by your machine) |
| Projects | Portable: data embedded in the project file | Portable or Linked (refers to the source file) |
| Recent projects, linked files | Not available | Available |
| Install | None, just open the link | `.dmg` (macOS universal), `.exe` / `.msi` (Windows) |

The web build uses a strict Content Security Policy: it makes no requests to other sites and
never loads DuckDB extensions from the network. See [docs/WEB.md](docs/WEB.md) for details.

## Tech stack

React 18 · TypeScript · Vite · Tailwind CSS · Radix UI · ECharts · DuckDB (Rust and Wasm) ·
Tauri 2 · Vitest

## Getting started

Requirements: Node.js 20+, [pnpm](https://pnpm.io) 10, and for the desktop app the
[Rust toolchain and Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
pnpm install
```

### Web app

```sh
pnpm dev:web       # dev server at http://localhost:5180
pnpm build:web     # static site in dist-web/
pnpm preview:web   # serve dist-web/ at http://localhost:5181 with the production CSP
```

`dist-web/` uses relative paths, so it can be hosted on any static host or sub-path. It must be
served over HTTP; it does not work from `file://`.

### Desktop app

```sh
pnpm tauri dev     # run the desktop app in development
pnpm build:mac     # universal macOS .app and .dmg
pnpm build:win     # Windows NSIS installer and .msi
```

### Tests

```sh
pnpm test          # frontend and web-backend tests (Vitest)
pnpm test:rust     # Rust backend tests
pnpm typecheck
```

A cross-check test runs the same queries through the Rust and DuckDB-Wasm backends and checks
that they return the same results.

## Project structure

```
src/
  app/              screens (Home, Data, Dashboard) and sidebar
  features/         charts, dashboard, data import, export, project
  components/       shared UI components
  lib/backend/      backend interface: Tauri (desktop) and DuckDB-Wasm (web)
src-tauri/          Rust backend: import, query builder, projects, export
docs/               WEB.md (web build notes), QA.md (release checklist)
```

## Deployment

Every push to `main` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which
builds the web app and publishes `dist-web/` to the `gh-pages` branch. GitHub Pages serves it at
[adarshnair.online/data_canvas](https://adarshnair.online/data_canvas/).

## Author

[Adarsh Nair](https://adarshnair.online)
