import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tripwire for the defect that made every other coverage claim meaningless.
 *
 * Before the CCROUTE-001 audit, `vitest.config.ts` restricted coverage measurement to
 * five of twelve `src/` directories, excluding 1,892 of 3,822 lines (49.5%) — including
 * subprocess and secret redaction, two of the eight areas §35 requires to be measured.
 * The headline "90.55% lines" was arithmetically true over a curated subset and told you
 * nothing about half the shipped code.
 *
 * A coverage THRESHOLD cannot catch this on its own: narrowing the measured scope makes
 * the percentage go UP, so re-introducing the bug would make CI greener, not redder.
 * This test guards the instrument itself rather than the reading.
 *
 * If you are here because this test failed: do not "fix" it by editing the expectation.
 * Either measure all of `src/`, or record in the pull request exactly what you excluded
 * and why, and get that reviewed.
 */
describe("coverage instrument scope", () => {
  const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");

  it("measures all of src/, not a curated subset", () => {
    const include = config.match(/include:\s*\[([^\]]*)\]/g) ?? [];
    // The coverage block's include is the second `include:` in the file; the first is
    // the test-file glob. Match on content rather than position to stay robust.
    const coverageInclude = include.find((block) => block.includes("src/"));
    expect(coverageInclude, "no coverage include found in vitest.config.ts").toBeTruthy();
    expect(
      coverageInclude,
      "coverage include must be exactly src/**/*.ts — anything narrower hides shipped code " +
        "behind a higher-looking percentage",
    ).toMatch(/["']src\/\*\*\/\*\.ts["']/);

    // A single glob, not a hand-picked directory list.
    const entries = (coverageInclude ?? "").split(",").filter((e) => e.trim().length > 0);
    expect(
      entries.length,
      `coverage include lists ${entries.length} patterns; expected exactly one (src/**/*.ts). A directory list is how the original defect was introduced.`,
    ).toBe(1);
  });

  it("does not exclude any src/ path from coverage", () => {
    const coverageBlock = config.slice(config.indexOf("coverage:"));
    const exclude = coverageBlock.match(/exclude:\s*\[([^\]]*)\]/);
    if (!exclude) return; // no coverage-level exclude at all is the desired state
    expect(
      exclude[1],
      "coverage exclude must not reference src/ — record the gap in the PR instead of " +
        "hiding it from the measurement",
    ).not.toMatch(/src\//);
  });

  it("keeps thresholds at or above the §35 bar", () => {
    const lines = config.match(/lines:\s*(\d+)/);
    const branches = config.match(/branches:\s*(\d+)/);
    expect(Number(lines?.[1] ?? 0)).toBeGreaterThanOrEqual(90);
    expect(Number(branches?.[1] ?? 0)).toBeGreaterThanOrEqual(84);
  });
});
