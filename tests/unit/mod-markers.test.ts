import { describe, expect, it } from "vitest";
import {
  parseRouterMarkers,
  shouldAutoRoute,
} from "../../src/integrations/commandcode-mod/markers.js";

describe("mod markers", () => {
  it("parses route-off and preserves task text", () => {
    const p = parseRouterMarkers("!route-off fix the bug in auth");
    expect(p.routeOff).toBe(true);
    expect(p.cleaned).toBe("fix the bug in auth");
    expect(p.routingText).toBe("fix the bug in auth");
  });

  it("parses profile and model override", () => {
    const p = parseRouterMarkers("!frontier !model=deepseek/deepseek-v4-flash implement router");
    expect(p.profile).toBe("frontier");
    expect(p.modelOverride).toBe("deepseek/deepseek-v4-flash");
    expect(p.cleaned).toBe("implement router");
  });

  it("parses cheap as cheapest profile", () => {
    expect(parseRouterMarkers("!cheap refactor").profile).toBe("cheapest");
    expect(parseRouterMarkers("!balanced refactor").profile).toBe("balanced");
  });

  it("shouldAutoRoute respects session and markers", () => {
    const off = parseRouterMarkers("!route-off hello");
    expect(shouldAutoRoute(true, off)).toBe(false);
    const on = parseRouterMarkers("!route-on hello");
    expect(shouldAutoRoute(false, on)).toBe(true);
    const plain = parseRouterMarkers("hello");
    expect(shouldAutoRoute(true, plain)).toBe(true);
    expect(shouldAutoRoute(false, plain)).toBe(false);
  });

  it("does not invent markers from ordinary punctuation", () => {
    const p = parseRouterMarkers("email me at user!cheap@example.com");
    // !cheap only matches as a token with whitespace boundaries
    expect(p.profile).toBeNull();
  });
});
