import { describe, expect, it } from "vitest";
import { WEB_CSP, webCspString } from "@/lib/webCsp";

describe("web build CSP", () => {
  it("allows only the same origin, blob: and Wasm compilation", () => {
    expect(WEB_CSP["default-src"]).toBe("'self'");
    expect(WEB_CSP["script-src"]).toBe("'self' 'wasm-unsafe-eval'");
    expect(WEB_CSP["object-src"]).toBe("'none'");
    for (const [directive, value] of Object.entries(WEB_CSP)) {
      const remote = value.split(/\s+/).filter((s) => /^(https?:|wss?:|\*)|\*/.test(s) || s === "'unsafe-eval'");
      expect(remote, directive).toEqual([]);
    }
    expect(webCspString()).not.toMatch(/https?:/);
  });
});
