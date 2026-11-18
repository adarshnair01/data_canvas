/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import process from "node:process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { webCspString } from "./src/lib/webCsp";

const host = process.env.TAURI_DEV_HOST;

/** Web build only: a strict same-origin CSP meta tag (the desktop CSP lives in tauri.conf.json). */
function webCsp(): Plugin {
  return {
    name: "datacanvas-web-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: webCspString() }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    plugins: [react(), tailwindcss(), ...(web ? [webCsp()] : [])],
    define: {
      "import.meta.env.VITE_TARGET": JSON.stringify(web ? "web" : "desktop"),
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    clearScreen: false,
    // A relative base lets the web build be served from any static host path.
    base: web ? "./" : "/",
    optimizeDeps: web ? { exclude: ["@duckdb/duckdb-wasm"] } : undefined,
    server: web
      ? { port: 5180, strictPort: true }
      : {
          port: 1420,
          strictPort: true,
          host: host || false,
          hmr: host
            ? {
                protocol: "ws",
                host,
                port: 1421,
              }
            : undefined,
          watch: {
            ignored: ["**/src-tauri/**"],
          },
        },
    preview: web ? { port: 5181, strictPort: true } : undefined,
    build: {
      target: "es2022",
      outDir: web ? "dist-web" : "dist",
      chunkSizeWarningLimit: 2500,
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  };
});
