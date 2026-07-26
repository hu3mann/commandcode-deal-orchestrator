import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnCommandCode } from "../../src/subprocess/commandcode.js";
import { buildChildProcessEnv, scrubEnvForLog } from "../../src/subprocess/environment.js";
import { withTimeoutSignal } from "../../src/subprocess/timeout.js";

/**
 * All "executables" spawned in this file are fake, throwaway scripts written
 * to a per-test temp directory -- never the real `cmd` / CommandCode CLI.
 * Per the project rules, `ccroute run`/`orchestrate`, `--network`, and
 * CCROUTE_LIVE=1 are never exercised anywhere here.
 *
 * Each fake executable is a tiny Node script invoked directly (no shell,
 * no PATH lookup): its shebang line points at `process.execPath` (the exact
 * node binary running the test), so it needs neither `/usr/bin/env` nor a
 * `node` on PATH.
 */
function writeFakeExe(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${body}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `path` exists and is non-empty, or throws after `maxWaitMs`. */
async function waitForNonEmptyFile(path: string, maxWaitMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if (statSync(path).size > 0) return;
    } catch {
      /* not created yet */
    }
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`${path} was never created/non-empty within ${maxWaitMs}ms`);
    }
    await sleepMs(25);
  }
}

describe("spawnCommandCode", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-subproc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. fixed argv --------------------------------------------------------
  it("1. sends the exact, fixed argv to the child (proven by the child itself)", async () => {
    const exe = writeFakeExe(
      dir,
      "echo-argv.js",
      `process.stdout.write(JSON.stringify(process.argv.slice(2)));`,
    );
    const res = await spawnCommandCode({
      cmdPath: exe,
      model: "claude-test-model",
      stdinText: "irrelevant for this test",
      trust: true,
      outputFormat: "json",
      cwd: dir,
    });
    expect(res.exitCode).toBe(0);
    const childSawArgv = JSON.parse(res.stdout);
    expect(childSawArgv).toEqual([
      "--print",
      "--model",
      "claude-test-model",
      "--skip-onboarding",
      "--trust",
      "--output-format",
      "json",
    ]);
    // spawnCommandCode's own returned argv record must match what was sent.
    expect(res.argv).toEqual([exe, ...childSawArgv]);
  });

  // 2. shell: false -- no shell interpretation ----------------------------
  it("2. shell:false -- a task with $(touch pwned) does not create the file, and metacharacters are not glob/shell interpreted", async () => {
    // Seed cwd with files so that if the child's argv/model were ever passed
    // through an actual shell and a `*` metachar leaked into the command
    // line, glob expansion would visibly corrupt what the child receives.
    writeFileSync(join(dir, "one.txt"), "");
    writeFileSync(join(dir, "two.txt"), "");

    const exe = writeFakeExe(
      dir,
      "dump-argv-and-stdin.js",
      `
      const fs = require("fs");
      const stdin = fs.readFileSync(0, "utf8");
      fs.writeFileSync("stdin-dump.txt", stdin);
      fs.writeFileSync("argv-dump.json", JSON.stringify(process.argv.slice(2)));
      `,
    );

    // A model id containing shell glob/metacharacters that assertSafeModelId
    // does NOT reject (it only rejects \n\r\0;|&$\`<> and a leading '-').
    const trickyModel = "a*b(c)d'e\"f~g";
    const dangerousTask = "before $(touch PWNED_MARKER) && touch PWNED_MARKER2 || true after";

    const res = await spawnCommandCode({
      cmdPath: exe,
      model: trickyModel,
      stdinText: dangerousTask,
      cwd: dir,
    });

    expect(res.exitCode).toBe(0);

    // The dangerous shell command embedded in the task must never have been
    // executed by anything in the pipeline.
    expect(() => statSync(join(dir, "PWNED_MARKER"))).toThrow();
    expect(() => statSync(join(dir, "PWNED_MARKER2"))).toThrow();

    // The model id argv token must arrive byte-for-byte, unexpanded --
    // proof there is no shell glob-expanding `*` against one.txt/two.txt.
    const argvSeen: string[] = JSON.parse(readFileSync(join(dir, "argv-dump.json"), "utf8"));
    expect(argvSeen).toContain(trickyModel);

    // The task/stdin content must also arrive byte-for-byte.
    const stdinSeen = readFileSync(join(dir, "stdin-dump.txt"), "utf8");
    expect(stdinSeen).toBe(dangerousTask);
  });

  // 3. stdin packet delivery (not argv) -----------------------------------
  it("3. delivers the packet on stdin, never as an argv token", async () => {
    const exe = writeFakeExe(
      dir,
      "dump-both.js",
      `
      const fs = require("fs");
      const stdin = fs.readFileSync(0, "utf8");
      process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));
      `,
    );
    const distinctivePacket = "DISTINCTIVE_PACKET_MARKER_9f8e7d role=executor do the thing";
    const res = await spawnCommandCode({
      cmdPath: exe,
      model: "m1",
      stdinText: distinctivePacket,
      cwd: dir,
    });
    const seen = JSON.parse(res.stdout) as { argv: string[]; stdin: string };
    expect(seen.stdin).toBe(distinctivePacket);
    for (const tok of seen.argv) {
      expect(tok).not.toContain("DISTINCTIVE_PACKET_MARKER_9f8e7d");
    }
  });

  // 4. successful exit ------------------------------------------------------
  it("4. reports a clean, successful exit", async () => {
    const exe = writeFakeExe(
      dir,
      "exit-0.js",
      `process.stdout.write("all good"); process.exit(0);`,
    );
    const res = await spawnCommandCode({ cmdPath: exe, model: "m1", stdinText: "x", cwd: dir });
    expect(res.exitCode).toBe(0);
    expect(res.signal).toBeNull();
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("all good");
  });

  // 5. nonzero exit is preserved, not swallowed -----------------------------
  it("5. preserves a nonzero exit code rather than swallowing it", async () => {
    const exe = writeFakeExe(dir, "exit-7.js", `process.stderr.write("boom"); process.exit(7);`);
    const res = await spawnCommandCode({ cmdPath: exe, model: "m1", stdinText: "x", cwd: dir });
    expect(res.exitCode).toBe(7);
    expect(res.timedOut).toBe(false);
    expect(res.stderr).toContain("boom");
  });

  // 6. timeout kills the child ----------------------------------------------
  it("6. kills a child that runs past the timeout, and it actually stops running", async () => {
    const exe = writeFakeExe(
      dir,
      "hang.js",
      `
        const fs = require("fs");
        setInterval(() => fs.appendFileSync("heartbeat.txt", "x"), 20);
        setInterval(() => {}, 999999); // keep event loop alive indefinitely
        `,
    );
    const res = await spawnCommandCode({
      cmdPath: exe,
      model: "m1",
      stdinText: "x",
      cwd: dir,
      // Generous relative to a trivial node script's startup time, but the
      // child never exits on its own (infinite intervals), so this always
      // exercises the timeout path regardless of the exact value.
      timeoutMs: 1000,
    });
    expect(res.timedOut).toBe(true);

    // Prove the process was actually killed, not merely abandoned: the
    // heartbeat file must stop growing after the kill.
    await waitForNonEmptyFile(join(dir, "heartbeat.txt"), 500);
    const sizeRightAfter = statSync(join(dir, "heartbeat.txt")).size;
    await sleepMs(600);
    const sizeLater = statSync(join(dir, "heartbeat.txt")).size;
    expect(sizeLater).toBe(sizeRightAfter);
  }, 8000);

  // 7. stdout is capped -------------------------------------------------------
  it("7. caps captured stdout at maxStdoutBytes instead of buffering unbounded output", async () => {
    const exe = writeFakeExe(
      dir,
      "flood-stdout.js",
      `
      const chunk = "A".repeat(1024);
      for (let i = 0; i < 2000; i++) process.stdout.write(chunk); // ~2MB
      `,
    );
    const cap = 5000;
    const res = await spawnCommandCode({
      cmdPath: exe,
      model: "m1",
      stdinText: "x",
      cwd: dir,
      maxStdoutBytes: cap,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.length).toBe(cap);
  });

  // 8. stderr is capped --------------------------------------------------------
  it("8. caps captured stderr at maxStderrBytes instead of buffering unbounded output", async () => {
    const exe = writeFakeExe(
      dir,
      "flood-stderr.js",
      `
      const chunk = "B".repeat(1024);
      for (let i = 0; i < 2000; i++) process.stderr.write(chunk); // ~2MB
      `,
    );
    const cap = 3000;
    const res = await spawnCommandCode({
      cmdPath: exe,
      model: "m1",
      stdinText: "x",
      cwd: dir,
      maxStderrBytes: cap,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stderr.length).toBe(cap);
  });

  // 9. whole process GROUP is killed, not just the immediate child -----------
  it("9. kills the whole process group on timeout -- a grandchild dies too", async () => {
    const exe = writeFakeExe(
      dir,
      "forks-grandchild.js",
      `
        const { spawn } = require("child_process");
        // Deliberately NOT detached: it must inherit this process's process
        // group, exactly like a real child of the CommandCode CLI would.
        spawn(process.execPath, [
          "-e",
          "setInterval(() => require('fs').appendFileSync('grandchild-heartbeat.txt', 'x'), 20)",
        ], { cwd: process.cwd(), stdio: "ignore" });
        setInterval(() => {}, 999999); // parent also stays alive
        `,
    );
    const res = await spawnCommandCode({
      cmdPath: exe,
      model: "m1",
      stdinText: "x",
      cwd: dir,
      // Generous: needs time for the parent node process AND a second,
      // grandchild node process to both start up before the timeout fires,
      // but the parent never exits on its own so this always times out.
      timeoutMs: 1200,
    });
    expect(res.timedOut).toBe(true);

    // Confirm the grandchild actually got going, then confirm it stops
    // growing (i.e. the grandchild died along with the immediate child).
    await waitForNonEmptyFile(join(dir, "grandchild-heartbeat.txt"), 500);
    const sizeAfterKill = statSync(join(dir, "grandchild-heartbeat.txt")).size;
    await sleepMs(600);
    const sizeLater = statSync(join(dir, "grandchild-heartbeat.txt")).size;
    expect(sizeLater).toBe(sizeAfterKill);
  }, 8000);

  // 10. malformed executable path ----------------------------------------------
  it("10. resolves (does not throw/hang) with an error result for a malformed/missing executable path", async () => {
    const badPath = join(dir, "this-does-not-exist-at-all");
    const res = await spawnCommandCode({ cmdPath: badPath, model: "m1", stdinText: "x", cwd: dir });
    expect(res.exitCode).toBe(1);
    expect(res.timedOut).toBe(false);
    expect(res.stderr.toLowerCase()).toMatch(/enoent|no such file/);
    expect(res.argv[0]).toBe(badPath);
  });

  // 11. task containing shell metacharacters arrives verbatim -------------------
  it("11. a task full of shell metacharacters is delivered verbatim over stdin, never interpreted", async () => {
    const exe = writeFakeExe(
      dir,
      "dump-stdin.js",
      `const fs = require("fs"); fs.writeFileSync("stdin-dump.txt", fs.readFileSync(0, "utf8"));`,
    );
    const nasty =
      "rm -rf / ; echo hi | cat && (echo grouped) || echo fallback `echo backticked` > out.txt < in.txt & disown";
    const res = await spawnCommandCode({ cmdPath: exe, model: "m1", stdinText: nasty, cwd: dir });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(dir, "stdin-dump.txt"), "utf8")).toBe(nasty);
    // None of the metacharacters should have caused any side effects.
    expect(() => statSync(join(dir, "out.txt"))).toThrow();
    expect(() => statSync(join(dir, "in.txt"))).toThrow();
  });

  // 12. task containing newlines arrives verbatim, unsplit ----------------------
  it("12. a task containing embedded newlines/CRLF is delivered verbatim over stdin", async () => {
    const exe = writeFakeExe(
      dir,
      "dump-stdin2.js",
      `const fs = require("fs"); fs.writeFileSync("stdin-dump.txt", fs.readFileSync(0, "utf8"));`,
    );
    const multiline = "line one\nline two\r\nline three\n\nline five with trailing blank above";
    const res = await spawnCommandCode({
      cmdPath: exe,
      model: "m1",
      stdinText: multiline,
      cwd: dir,
    });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(dir, "stdin-dump.txt"), "utf8")).toBe(multiline);
  });

  // 13. model ID containing injection characters is rejected before spawning ----
  it("13. rejects model IDs containing injection characters instead of ever spawning", async () => {
    const exe = writeFakeExe(
      dir,
      "should-never-run.js",
      `require("fs").writeFileSync("should-not-exist.txt", "ran");`,
    );
    const badModelIds = [
      "--auto-accept",
      "-y",
      "model; rm -rf /",
      "model`touch pwned`",
      "model\nrm -rf /",
      "model\0hidden",
      "../../etc/passwd",
      "model$(touch pwned)",
    ];
    for (const bad of badModelIds) {
      await expect(
        spawnCommandCode({ cmdPath: exe, model: bad, stdinText: "x", cwd: dir }),
      ).rejects.toThrow();
    }
    expect(() => statSync(join(dir, "should-not-exist.txt"))).toThrow();
  });

  // Extra: role/runId wiring (recursion-guard env + child role instruction) ----
  it("wires opts.role/runId into both the stdin prefix and the child's recursion-guard env vars", async () => {
    const exe = writeFakeExe(
      dir,
      "dump-env-and-stdin.js",
      `
      const fs = require("fs");
      const stdin = fs.readFileSync(0, "utf8");
      process.stdout.write(JSON.stringify({
        stdin,
        CCROUTE_CHILD: process.env.CCROUTE_CHILD ?? null,
        CCROUTE_DEPTH: process.env.CCROUTE_DEPTH ?? null,
        CCROUTE_ROLE: process.env.CCROUTE_ROLE ?? null,
        CCROUTE_RUN_ID: process.env.CCROUTE_RUN_ID ?? null,
      }));
      `,
    );
    const res = await spawnCommandCode({
      cmdPath: exe,
      model: "m1",
      stdinText: "the actual task",
      cwd: dir,
      role: "executor",
      runId: "run-abc-123",
    });
    const seen = JSON.parse(res.stdout);
    expect(seen.stdin.startsWith("You are a bounded role process.")).toBe(true);
    expect(seen.stdin.endsWith("the actual task")).toBe(true);
    expect(seen.CCROUTE_CHILD).toBe("1");
    expect(seen.CCROUTE_ROLE).toBe("executor");
    expect(seen.CCROUTE_RUN_ID).toBe("run-abc-123");
    expect(seen.CCROUTE_DEPTH).toBe("1");
  });

  // Extra: killTree's win32 branch (child.kill fallback, no process-group kill) --
  it("on a win32-shaped platform, kills via child.kill() directly rather than a process-group signal", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const exe = writeFakeExe(
        dir,
        "hang-win32.js",
        `
        const fs = require("fs");
        setInterval(() => fs.appendFileSync("heartbeat.txt", "x"), 20);
        setInterval(() => {}, 999999);
        `,
      );
      const res = await spawnCommandCode({
        cmdPath: exe,
        model: "m1",
        stdinText: "x",
        cwd: dir,
        timeoutMs: 1000,
      });
      expect(res.timedOut).toBe(true);
      await waitForNonEmptyFile(join(dir, "heartbeat.txt"), 500);
      const sizeRightAfter = statSync(join(dir, "heartbeat.txt")).size;
      await sleepMs(600);
      expect(statSync(join(dir, "heartbeat.txt")).size).toBe(sizeRightAfter);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  }, 8000);
});

describe("scrubEnvForLog", () => {
  it("redacts values whose key looks sensitive, case-insensitively, and skips undefined values", () => {
    const env = {
      API_KEY: "shh",
      my_token_value: "shh2",
      SECRET_THING: "shh3",
      PASSWORD1: "shh4",
      SOME_CREDENTIAL: "shh5",
      AUTHORIZATION_HEADER: "shh6",
      XAI_API_KEY: "shh7",
      OPENAI_API_KEY: "shh8",
      ANTHROPIC_API_KEY: "shh9",
      PLAIN_VAR: "keep-me",
      UNDEFINED_VAR: undefined,
    };
    const out = scrubEnvForLog(env as unknown as NodeJS.ProcessEnv);
    expect(out.API_KEY).toBe("[REDACTED]");
    expect(out.my_token_value).toBe("[REDACTED]");
    expect(out.SECRET_THING).toBe("[REDACTED]");
    expect(out.PASSWORD1).toBe("[REDACTED]");
    expect(out.SOME_CREDENTIAL).toBe("[REDACTED]");
    expect(out.AUTHORIZATION_HEADER).toBe("[REDACTED]");
    expect(out.XAI_API_KEY).toBe("[REDACTED]");
    expect(out.OPENAI_API_KEY).toBe("[REDACTED]");
    expect(out.ANTHROPIC_API_KEY).toBe("[REDACTED]");
    expect(out.PLAIN_VAR).toBe("keep-me");
    expect("UNDEFINED_VAR" in out).toBe(false);
  });
});

describe("buildChildProcessEnv", () => {
  it("merges extra env on top of base env, with extra taking precedence", () => {
    const base = { FOO: "base-foo", SHARED: "base-shared" } as unknown as NodeJS.ProcessEnv;
    const extra = { SHARED: "extra-shared", BAR: "extra-bar" };
    const merged = buildChildProcessEnv(base, extra);
    expect(merged.FOO).toBe("base-foo");
    expect(merged.SHARED).toBe("extra-shared");
    expect(merged.BAR).toBe("extra-bar");
  });
});

describe("withTimeoutSignal", () => {
  it("aborts the signal once timeoutMs elapses", async () => {
    const { signal } = withTimeoutSignal(20);
    expect(signal.aborted).toBe(false);
    await sleepMs(80);
    expect(signal.aborted).toBe(true);
  });

  it("clear() prevents the signal from ever aborting", async () => {
    const { signal, clear } = withTimeoutSignal(20);
    clear();
    await sleepMs(80);
    expect(signal.aborted).toBe(false);
  });
});
