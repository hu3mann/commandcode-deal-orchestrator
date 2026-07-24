import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandHome, loadConfig, validateConfigFile } from "../../src/config/loader.js";
import { ConfigError } from "../../src/config/merge.js";

describe("config loader", () => {
  let dir: string;
  const prevHome = process.env.HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-cfg-"));
    process.env.HOME = dir;
    mkdirSync(join(dir, ".commandcode"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads defaults when no files", () => {
    const loaded = loadConfig({ cwd: dir });
    expect(loaded.config.schemaVersion).toBe(1);
    expect(loaded.sources).toContain("built-in defaults");
  });

  it("loads user config", () => {
    writeFileSync(join(dir, ".commandcode", "deal-router.yaml"), "noFree: true\n");
    const proj = join(dir, "proj");
    mkdirSync(proj, { recursive: true });
    const loaded = loadConfig({ cwd: proj });
    expect(loaded.config.noFree).toBe(true);
    expect(loaded.paths.user).toBeTruthy();
  });

  it("fails closed on malformed project config", () => {
    const proj = join(dir, "p");
    mkdirSync(join(proj, ".commandcode"), { recursive: true });
    writeFileSync(
      join(proj, ".commandcode", "deal-router.yaml"),
      "profiles:\n  cheapest:\n    costWeight: not-a-number\n",
    );
    expect(() => loadConfig({ cwd: proj })).toThrow(ConfigError);
  });

  it("validateConfigFile missing", () => {
    const r = validateConfigFile(join(dir, "nope.yaml"));
    expect(r.ok).toBe(false);
  });

  it("validateConfigFile ok", () => {
    const p = join(dir, "ok.yaml");
    writeFileSync(p, "noFree: false\n");
    expect(validateConfigFile(p).ok).toBe(true);
  });

  it("expandHome", () => {
    expect(expandHome("~/x")).toContain("x");
    expect(expandHome("~")).toBe(dir);
    expect(expandHome("/abs")).toBe("/abs");
  });
});
