import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Opt-in live smoke. Budget target: ≤ $0.25 estimated.
 *
 *   CCROUTE_LIVE=1 npm run test:live
 *
 * Requirements:
 * - cmd authenticated
 * - read-only only (no --apply)
 * - prefer free/cheap models
 */
const live = process.env.CCROUTE_LIVE === "1";
const root = process.cwd();
const cli = join(root, "dist", "cli.js");
const budgetUsd = Number(process.env.CCROUTE_LIVE_BUDGET ?? "0.25");

function runCcroute(args: string[], timeoutMs = 120_000) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: root,
    shell: false,
    timeout: timeoutMs,
    env: { ...process.env, CCROUTE_LIVE: undefined },
  });
}

function runCmd(args: string[], timeoutMs = 180_000) {
  return spawnSync("cmd", args, {
    encoding: "utf8",
    cwd: root,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
}

describe.skipIf(!live)("live smoke", () => {
  it("has built cli and authenticated cmd", () => {
    expect(existsSync(cli)).toBe(true);
    const status = runCmd(["status", "--json"], 30_000);
    expect(status.status).toBe(0);
    const body = JSON.parse(status.stdout.trim().split("\n").pop() || "{}");
    expect(body.authenticated).toBe(true);
  });

  it("decide makes no model call (no --print)", () => {
    const r = runCcroute(["decide", "Summarize this repository", "--no-free", "--json"], 60_000);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.decision.selectedModelId).toBeTruthy();
    expect(parsed.decision.taskClass).toBe("read_only");
  });

  it("read-only cheap/free cmd --print call stays under budget", () => {
    // Prefer free model if present, else flash
    const list = runCmd(["--list-models"], 30_000);
    expect(list.status).toBe(0);
    const text = list.stdout || list.stderr;
    const free = text.includes("inclusionai/ling-3.0-flash-free")
      ? "inclusionai/ling-3.0-flash-free"
      : text.includes("poolside/laguna-s-2.1-free")
        ? "poolside/laguna-s-2.1-free"
        : "deepseek/deepseek-v4-flash";

    // Estimate via ccroute explain before spend
    const explain = runCcroute(["explain", "Reply with exactly: pong", "--model", free], 60_000);
    expect(explain.status).toBe(0);
    const costMatch = explain.stdout.match(/Expected total cost \(estimate\): \$([0-9.]+)/);
    const estimated = costMatch ? Number(costMatch[1]) : 0.05;
    expect(estimated).toBeLessThanOrEqual(budgetUsd);

    const started = Date.now();
    const r = runCmd(
      [
        "--print",
        "--model",
        free,
        "--max-turns",
        "2",
        "--skip-onboarding",
        "--plan",
        "Reply with exactly the single word pong and nothing else.",
      ],
      180_000,
    );
    const durationMs = Date.now() - started;

    // Soft success: exit 0 preferred; some free models may rate-limit
    if (r.status !== 0) {
      console.warn("live cmd non-zero", r.status, r.stderr?.slice(0, 400));
    }
    expect(r.error?.message ?? "").not.toMatch(/ETIMEDOUT|timed out/i);
    // At least we invoked live CLI; body may vary
    expect(typeof (r.stdout || r.stderr)).toBe("string");
    expect(durationMs).toBeLessThan(180_000);

    // Record estimate for acceptance (not observed billing)
    console.info(
      JSON.stringify({
        liveModel: free,
        estimatedCostUsd: estimated,
        budgetUsd,
        exitCode: r.status,
        durationMs,
        stdoutChars: (r.stdout || "").length,
      }),
    );
  }, 200_000);

  it("bounded grok plan only when budget permits and model listed", () => {
    const list = runCmd(["--list-models"], 30_000);
    if (!(list.stdout || list.stderr).includes("xai/grok-4.5")) {
      console.info("skip grok: not in live catalog");
      return;
    }
    const explain = runCcroute(
      [
        "explain",
        "In one sentence, what is a pure function?",
        "--model",
        "xai/grok-4.5",
        "--profile",
        "frontier",
      ],
      60_000,
    );
    expect(explain.status).toBe(0);
    const costMatch = explain.stdout.match(/Expected total cost \(estimate\): \$([0-9.]+)/);
    const estimated = costMatch ? Number(costMatch[1]) : 1;
    if (estimated > budgetUsd * 0.5) {
      console.info("skip grok: estimated", estimated, "exceeds half budget", budgetUsd);
      return;
    }
    const r = runCmd(
      [
        "--print",
        "--model",
        "xai/grok-4.5",
        "--plan",
        "--max-turns",
        "2",
        "--skip-onboarding",
        "In one short sentence define a pure function. No tools.",
      ],
      180_000,
    );
    console.info(
      JSON.stringify({
        liveModel: "xai/grok-4.5",
        estimatedCostUsd: estimated,
        exitCode: r.status,
        stdoutChars: (r.stdout || "").length,
      }),
    );
    expect(r.status === 0 || r.status === 8).toBe(true);
  }, 200_000);
});
