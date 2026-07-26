import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Integration: decide must not invoke cmd. We put a counting fake cmd first on PATH
 * and ensure it is never executed for decide when we also allow offline seed routing.
 * Actually decide still probes list-models if cmd exists. Spec: decide performs no *model* call.
 * Fake cmd that exits 99 if --print is used, and returns empty models for --list-models.
 */
describe("decide no model call", () => {
  it("never passes --print to cmd", () => {
    const dir = join(tmpdir(), `ccroute-fake-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const fake = join(dir, "cmd");
    writeFileSync(
      fake,
      `#!/usr/bin/env bash
echo "$@" >> "${dir}/invocations.log"
if [[ "$*" == *"--print"* ]]; then
  echo "MODEL_CALL" >> "${dir}/invocations.log"
  exit 99
fi
if [[ "$*" == *"--list-models"* ]]; then
  echo "deepseek/deepseek-v4-flash"
  echo "xiaomi/mimo-v2.5"
  echo "xiaomi/mimo-v2.5-pro"
  echo "deepseek/deepseek-v4-pro"
  echo "xai/grok-4.5"
  echo "claude-sonnet-5"
  exit 0
fi
if [[ "$*" == *"--version"* ]]; then echo "fake 0.0.0"; exit 0; fi
if [[ "$*" == *"status"* ]]; then echo '{"authenticated":true}'; exit 0; fi
exit 0
`,
    );
    chmodSync(fake, 0o755);

    const cli = join(process.cwd(), "dist", "cli.js");
    // build may not exist yet — use tsx-less node with built file; run via npx vitest after build
    const r = spawnSync(
      process.execPath,
      [cli, "decide", "Summarize this repository", "--no-free"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CCROUTE_CMD_PATH: fake },
        cwd: process.cwd(),
      },
    );

    // If not built or spawn failed, fail the test explicitly
    if (r.error || r.status === null) {
      throw new Error(
        `Failed to run 'decide' command: ${r.error?.message || "spawn returned null status"}. Ensure the build exists at ${cli}`,
      );
    }

    const log = spawnSync("cat", [`${dir}/invocations.log`], { encoding: "utf8" });
    const content = log.stdout || "";
    expect(content).not.toContain("MODEL_CALL");
    expect(content).not.toMatch(/--print/);
  });
});
