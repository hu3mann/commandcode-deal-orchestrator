import { describe, expect, it } from "vitest";
import {
  canRouteAutomatically,
  inspectModApi,
  isVersionAtLeast,
  qualifyCommandCodeVersion,
} from "../../src/integrations/commandcode-mod/compatibility.js";
import type { ModApi } from "../../src/integrations/commandcode-mod/types.js";

function fullApi(): ModApi {
  return {
    name: "test",
    cwd: "/tmp",
    hooks: () => ({ dispose() {} }),
    addCommand: () => ({ dispose() {} }),
    on: () => ({ dispose() {} }),
    setModel: () => {},
    setEffort: () => {},
    ui: { notify: () => {} },
  };
}

describe("mod compatibility", () => {
  it("accepts supported CommandCode version and full API", () => {
    const report = qualifyCommandCodeVersion("1.4.1", inspectModApi(fullApi()));
    expect(report.status).toBe("SUPPORTED");
    expect(canRouteAutomatically(report)).toBe(true);
    expect(report.present).toContain("setModel");
    expect(report.present).toContain("hooks.transformInput");
  });

  it("rejects unsupported CommandCode version", () => {
    const report = qualifyCommandCodeVersion("1.2.0", inspectModApi(fullApi()));
    expect(report.status).toBe("UNSUPPORTED");
    expect(canRouteAutomatically(report)).toBe(false);
  });

  it("detects missing callbacks", () => {
    const report = inspectModApi({ name: "x", cwd: "/" } as ModApi);
    expect(report.status).toBe("MISSING_CALLBACK");
    expect(report.missing.length).toBeGreaterThan(0);
    expect(canRouteAutomatically(report)).toBe(false);
  });

  it("detects changed/partial API surface (no setModel)", () => {
    const partial = { ...fullApi(), setModel: undefined as unknown as ModApi["setModel"] };
    const report = inspectModApi(partial);
    expect(report.status).toBe("MISSING_CALLBACK");
    expect(report.missing).toContain("setModel");
  });

  it("degrades when version unknown but API present", () => {
    const report = qualifyCommandCodeVersion(null, inspectModApi(fullApi()));
    expect(report.status).toBe("DEGRADED");
    expect(canRouteAutomatically(report)).toBe(true);
  });

  it("compares semver correctly", () => {
    expect(isVersionAtLeast("1.4.1", "1.4.0")).toBe(true);
    expect(isVersionAtLeast("1.3.9", "1.4.0")).toBe(false);
    expect(isVersionAtLeast("not-a-version", "1.4.0")).toBe(false);
  });
});
