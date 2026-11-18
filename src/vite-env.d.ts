/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `"web"` for `pnpm build:web` / `pnpm dev:web`, otherwise `"desktop"`. */
  readonly VITE_TARGET: "web" | "desktop";
}
