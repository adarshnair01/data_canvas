# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Web version

`pnpm dev:web` runs DataCanvas fully in the browser (DuckDB-Wasm, no server), and `pnpm build:web`
builds a static site into `dist-web/`. Comfortable for CSV files up to about 200 MB; use the
desktop app for larger files. See [docs/WEB.md](docs/WEB.md) for limits and details.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
