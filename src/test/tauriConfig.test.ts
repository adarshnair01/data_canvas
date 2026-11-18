import { describe, expect, it } from "vitest";
import conf from "../../src-tauri/tauri.conf.json";

const csp = conf.app.security.csp as Record<string, string>;

describe("tauri.conf.json", () => {
  it("bundles the release targets under the product identifier", () => {
    expect(conf.identifier).toBe("com.datacanvas.desktop");
    expect(conf.bundle.active).toBe(true);
    expect([...conf.bundle.targets].sort()).toEqual(["app", "dmg", "msi", "nsis"]);
    expect(conf.bundle.icon).toEqual(expect.arrayContaining(["icons/icon.icns", "icons/icon.ico"]));
  });

  it("registers .datacanvas as an owned document type", () => {
    const [assoc] = conf.bundle.fileAssociations;
    expect(assoc.ext).toEqual(["datacanvas"]);
    expect(assoc.role).toBe("Editor");
    expect(assoc.rank).toBe("Owner");
  });

  it("ships no real signing material", () => {
    expect(conf.bundle.windows.certificateThumbprint).toBeNull();
    expect(conf.bundle.macOS.signingIdentity).toBe("-");
  });

  it("keeps a strict CSP with no remote origins", () => {
    expect(csp["default-src"]).toBe("'self'");
    expect(csp["script-src"]).toBe("'self'");
    expect(csp["object-src"]).toBe("'none'");
    for (const [directive, value] of Object.entries(csp)) {
      const sources = value.split(/\s+/);
      const remote = sources.filter((s) => /^(https?:|wss?:|\*)/.test(s) && s !== "http://ipc.localhost");
      expect(remote, directive).toEqual([]);
    }
  });
});
