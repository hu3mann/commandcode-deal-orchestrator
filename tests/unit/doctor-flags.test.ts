import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { probeCapabilities } from "../../src/discovery/capability-probe.js";

describe("doctor accuracy", () => {
  it("does not claim CLI flags when none provided", () => {
    const loaded = loadConfig();
    expect(loaded.sources).not.toContain("CLI flags");
  });

  it("detects auto-accept in full help when cmd present", () => {
    const caps = probeCapabilities();
    if (!caps.cmd.path) return;
    expect(caps.supportedFlags.print).toBe(true);
    expect(caps.supportedFlags.model).toBe(true);
    expect(caps.supportedFlags.listModels).toBe(true);
    // These appear later in help; must not be truncated away
    expect(caps.supportedFlags.autoAccept).toBe(true);
    expect(caps.supportedFlags.skipOnboarding).toBe(true);
    expect(caps.supportedFlags.yolo).toBe(true);
  }, 30_000);
});
