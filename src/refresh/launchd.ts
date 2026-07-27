/**
 * macOS launchd lifecycle for daily refresh.
 * No KeepAlive, no secrets, no shell pipelines, no root.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../config/loader.js";
import { launchdLabel, launchdPlistPath, refreshLogsDir } from "./paths.js";

export interface LaunchdInstallOptions {
  /** Absolute path to ccroute executable */
  ccroutePath: string;
  homeDir?: string;
  stateRoot?: string;
  /** Working directory (neutral/safe) */
  workingDirectory?: string;
  /** Hour of day for calendar schedule (local), default 4 */
  hour?: number;
  minute?: number;
}

export interface LaunchdResult {
  ok: boolean;
  action: string;
  plistPath: string;
  label: string;
  messages: string[];
  error?: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildLaunchdPlist(opts: LaunchdInstallOptions): string {
  const label = launchdLabel();
  const state = opts.stateRoot ?? stateDir();
  const logs = refreshLogsDir(state);
  const hour = opts.hour ?? 4;
  const minute = opts.minute ?? 0;
  const cwd = opts.workingDirectory ?? state;
  const stdout = join(logs, "launchd.stdout.log");
  const stderr = join(logs, "launchd.stderr.log");

  // ProgramArguments: absolute ccroute + "refresh" + "run" — no shell
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.ccroutePath)}</string>
    <string>refresh</string>
    <string>run</string>
    <string>--scheduled</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(cwd)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderr)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function validatePlistXml(xml: string): { ok: boolean; error?: string } {
  if (!xml.includes("<plist") || !xml.includes(launchdLabel())) {
    return { ok: false, error: "plist missing label or root" };
  }
  if (
    /KeepAlive\s*<\/key>\s*<true\s*\/>/i.test(xml) ||
    /<key>KeepAlive<\/key>\s*<true/i.test(xml)
  ) {
    return { ok: false, error: "KeepAlive must not be true" };
  }
  if (xml.includes("/bin/sh") || xml.includes("bash -c") || xml.includes("bash -c")) {
    return { ok: false, error: "shell pipelines forbidden" };
  }
  return { ok: true };
}

export type LaunchctlRunner = (
  args: string[],
  env?: NodeJS.ProcessEnv,
) => { status: number | null; stdout: string; stderr: string };

export function defaultLaunchctlRunner(
  args: string[],
  env?: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("launchctl", args, {
    encoding: "utf8",
    shell: false,
    env: env ?? process.env,
    timeout: 15_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let launchctlRunner: LaunchctlRunner = defaultLaunchctlRunner;

/** Test seam: inject launchctl runner (ESM-safe). */
export function setLaunchctlRunnerForTests(runner: LaunchctlRunner | null): void {
  launchctlRunner = runner ?? defaultLaunchctlRunner;
}

function runLaunchctl(
  args: string[],
  env?: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  return launchctlRunner(args, env);
}

export function installLaunchd(opts: LaunchdInstallOptions): LaunchdResult {
  const label = launchdLabel();
  const plistPath = launchdPlistPath(opts.homeDir);
  const messages: string[] = [];

  if (!opts.ccroutePath || !opts.ccroutePath.startsWith("/")) {
    return {
      ok: false,
      action: "install",
      plistPath,
      label,
      messages,
      error: "ccroutePath must be absolute",
    };
  }
  if (!existsSync(opts.ccroutePath)) {
    return {
      ok: false,
      action: "install",
      plistPath,
      label,
      messages,
      error: `ccroute binary not found: ${opts.ccroutePath}`,
    };
  }

  const state = opts.stateRoot ?? stateDir();
  mkdirSync(refreshLogsDir(state), { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });

  const xml = buildLaunchdPlist(opts);
  const valid = validatePlistXml(xml);
  if (!valid.ok) {
    return {
      ok: false,
      action: "install",
      plistPath,
      label,
      messages,
      error: valid.error,
    };
  }

  // Unload before replace (idempotent)
  if (existsSync(plistPath)) {
    const unload = runLaunchctl(["unload", plistPath]);
    messages.push(`unload: exit=${unload.status}`);
  }

  writeFileSync(plistPath, xml, { encoding: "utf8", mode: 0o644 });
  try {
    chmodSync(plistPath, 0o644);
  } catch {
    /* best-effort */
  }
  messages.push(`wrote ${plistPath}`);

  const load = runLaunchctl(["load", plistPath]);
  messages.push(`load: exit=${load.status} ${load.stderr || load.stdout}`.trim());

  // Verify
  const list = runLaunchctl(["list"]);
  const listed = list.stdout.includes(label) || list.stderr.includes(label);
  messages.push(
    listed ? "verified in launchctl list" : "warning: label not seen in launchctl list",
  );

  return {
    ok: load.status === 0 || listed,
    action: "install",
    plistPath,
    label,
    messages,
    error: load.status !== 0 && !listed ? load.stderr || "load failed" : undefined,
  };
}

export function uninstallLaunchd(opts?: { homeDir?: string }): LaunchdResult {
  const label = launchdLabel();
  const plistPath = launchdPlistPath(opts?.homeDir);
  const messages: string[] = [];

  if (existsSync(plistPath)) {
    const unload = runLaunchctl(["unload", plistPath]);
    messages.push(`unload: exit=${unload.status}`);
    try {
      unlinkSync(plistPath);
      messages.push(`removed ${plistPath}`);
    } catch (e) {
      return {
        ok: false,
        action: "uninstall",
        plistPath,
        label,
        messages,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } else {
    messages.push("plist absent");
  }

  return {
    ok: true,
    action: "uninstall",
    plistPath,
    label,
    messages,
  };
}

export function statusLaunchd(opts?: { homeDir?: string }): LaunchdResult & {
  installed: boolean;
  loaded: boolean;
  plist?: string;
} {
  const label = launchdLabel();
  const plistPath = launchdPlistPath(opts?.homeDir);
  const installed = existsSync(plistPath);
  const list = runLaunchctl(["list"]);
  const loaded = list.stdout.includes(label);
  const messages = [`plist=${installed ? "present" : "absent"}`, `loaded=${loaded}`];
  let plist: string | undefined;
  if (installed) {
    try {
      plist = readFileSync(plistPath, "utf8");
    } catch {
      /* best-effort */
    }
  }
  return {
    ok: true,
    action: "status",
    plistPath,
    label,
    messages,
    installed,
    loaded,
    plist,
  };
}

/** Resolve absolute path to this package's dist/cli.js or PATH ccroute */
export function resolveCcrouteAbsolute(env: NodeJS.ProcessEnv = process.env): string | null {
  const which = spawnSync("command", ["-v", "ccroute"], {
    encoding: "utf8",
    shell: false,
    env,
  });
  if (which.status === 0 && which.stdout.trim().startsWith("/")) {
    return which.stdout.trim();
  }
  // fall back to process.argv[1] when running as node dist/cli.js
  const entry = process.argv[1];
  if (entry?.startsWith("/")) return entry;
  return null;
}
