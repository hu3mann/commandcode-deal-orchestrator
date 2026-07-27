import { describe, expect, it } from "vitest";
import { packageRoot } from "../../src/config/defaults.js";
import { resolveInstallPaths, resolveScope } from "../../src/install/paths.js";

describe("install paths", () => {
  it("defaults scope to project", () => {
    expect(resolveScope({})).toBe("project");
    expect(resolveScope({ project: true })).toBe("project");
    expect(resolveScope({ user: true })).toBe("user");
  });

  it("rejects dual scope", () => {
    expect(() => resolveScope({ project: true, user: true })).toThrow(/simultaneous/);
  });

  it("resolves project and user roots", () => {
    const p = resolveInstallPaths({
      project: true,
      projectRoot: "/tmp/proj",
      homeDir: "/tmp/home",
      packageRoot: packageRoot(),
    });
    expect(p.manifestPath).toBe("/tmp/proj/.commandcode/ccroute-install-manifest.json");
    expect(p.settingsPath).toBe("/tmp/proj/.commandcode/settings.json");

    const u = resolveInstallPaths({
      user: true,
      projectRoot: "/tmp/proj",
      homeDir: "/tmp/home",
      packageRoot: packageRoot(),
    });
    expect(u.manifestPath).toBe("/tmp/home/.commandcode/ccroute-install-manifest.json");
  });
});
