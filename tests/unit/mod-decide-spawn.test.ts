import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideRoute,
  resolveCcrouteInvocation,
} from "../../src/integrations/commandcode-mod/router-client.js";

const cli = join(process.cwd(), "dist/cli.js");

describe("mod decideRoute spawn", () => {
  it("resolves package cli via node when present", () => {
    const inv = resolveCcrouteInvocation({});
    // Prefer built dist or PATH ccroute
    expect(inv.command).toBeTruthy();
    expect(Array.isArray(inv.prefixArgs)).toBe(true);
  });

  it("honors CCROUTE_BIN override", () => {
    const inv = resolveCcrouteInvocation({ CCROUTE_BIN: "/tmp/my-ccroute" });
    expect(inv.command).toBe("/tmp/my-ccroute");
    expect(inv.prefixArgs).toEqual([]);
  });

  it("runs real decide --json via built CLI (no model spawn)", async () => {
    const result = await decideRoute({
      taskText: "read the readme and summarize",
      timeoutMs: 1500,
      ccrouteCommand: { command: process.execPath, prefixArgs: [cli] },
    });
    // May succeed offline with seed pricing, or fail closed — must not hang.
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    if (result.ok) {
      expect(result.modelId).toBeTruthy();
      expect(result.decision).toBeTruthy();
    } else {
      expect(result.cause).toBeTruthy();
    }
  });

  it("times out when decide exceeds budget", async () => {
    const result = await decideRoute({
      taskText: "hello",
      timeoutMs: 1,
      ccrouteCommand: {
        command: process.execPath,
        prefixArgs: [
          "-e",
          "setTimeout(()=>{}, 5000)", // hang forever
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.cause).toBe("timeout");
  }, 10_000);

  it("classifies spawn errors", async () => {
    const result = await decideRoute({
      taskText: "x",
      timeoutMs: 500,
      ccrouteCommand: { command: "/definitely/not/a/binary-ccroute-xyz" },
    });
    expect(result.ok).toBe(false);
    expect(result.cause).toBe("spawn");
  });

  it("classifies non-zero exit as failure", async () => {
    const result = await decideRoute({
      taskText: "x",
      timeoutMs: 1500,
      ccrouteCommand: {
        command: process.execPath,
        prefixArgs: ["-e", "console.error('no eligible route'); process.exit(2)"],
      },
    });
    expect(result.ok).toBe(false);
    expect(["no_eligible_route", "unknown"]).toContain(result.cause);
  });
});
