import { describe, expect, it } from "vitest";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import { ConfigError, deepMerge, mergeConfigs } from "../../src/config/merge.js";
import { RoutingConfigSchema } from "../../src/config/schemas.js";

describe("config", () => {
  it("loads defaults", () => {
    const c = loadDefaultRoutingConfig();
    expect(c.schemaVersion).toBe(1);
    expect(c.profiles.cheapest.costWeight).toBeGreaterThan(0);
  });

  it("merges with precedence cli > project > user > defaults", () => {
    const defaults = loadDefaultRoutingConfig();
    const merged = mergeConfigs(
      defaults,
      { noFree: false },
      { noFree: true },
      { defaultProfile: "frontier" },
    );
    const parsed = RoutingConfigSchema.parse(merged);
    expect(parsed.noFree).toBe(true);
    expect(parsed.defaultProfile).toBe("frontier");
  });

  it("rejects unknown security-sensitive keys under security", () => {
    expect(() =>
      deepMerge({ security: { rejectUnknownSecurityKeys: true } }, { security: { yolo: true } }),
    ).toThrow(ConfigError);
  });

  it("malformed values fail schema", () => {
    const defaults = loadDefaultRoutingConfig();
    const merged = mergeConfigs(defaults, {
      profiles: { cheapest: { costWeight: "nope" } },
    } as never);
    const r = RoutingConfigSchema.safeParse(merged);
    expect(r.success).toBe(false);
  });
});
