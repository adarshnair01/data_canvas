/**
 * Content Security Policy for the static web build (injected as a `<meta>` tag at build time).
 * Same origin only: DuckDB-Wasm needs `wasm-unsafe-eval` to compile its bundled module and a
 * same-origin worker; downloads use `blob:` URLs. No remote origins, ever.
 */
export const WEB_CSP: Record<string, string> = {
  "default-src": "'self'",
  "script-src": "'self' 'wasm-unsafe-eval'",
  "worker-src": "'self' blob:",
  "connect-src": "'self' blob:",
  "img-src": "'self' data: blob:",
  "style-src": "'self' 'unsafe-inline'",
  "font-src": "'self' data:",
  "object-src": "'none'",
  "base-uri": "'self'",
  "form-action": "'none'",
  "frame-src": "'none'",
};

export const webCspString = () =>
  Object.entries(WEB_CSP)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
