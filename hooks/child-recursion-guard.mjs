#!/usr/bin/env node
/**
 * PreToolUse hook: deny child role sessions from invoking ccroute.
 * Reads JSON on stdin, writes JSON on stdout. No eval.
 */
import { readFileSync } from "node:fs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const raw = readStdin();
let payload = {};
try {
  payload = raw.trim() ? JSON.parse(raw) : {};
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

const isChild = process.env.CCROUTE_CHILD === "1";
if (!isChild) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const input = payload.tool_input || {};
const command = String(input.command || "");
const joined = `${command} ${(input.args || []).join(" ")}`.toLowerCase();

// Heuristic, defence-in-depth substring matching. This is NOT complete: it can be
// defeated by e.g. splitting the string across shell variables/concatenation, an
// unusual bin name, or invoking a differently-renamed copy of dist/cli.js. It raises
// the bar against the obvious bypasses observed so far (renamed/symlinked bin, direct
// `node dist/cli.js` invocation) — it is not a sandbox.
const blocked =
  /\bccroute\b/.test(joined) ||
  /commandcode-deal-orchestrator/.test(joined) ||
  /\bnpx\s+ccroute\b/.test(joined) ||
  // Catches `node dist/cli.js ...`, `node ./cli.js ...`, a symlink named cli.js, etc.
  // — the actual bin entry point (see package.json "bin": { "ccroute": "./dist/cli.js" })
  // invoked directly instead of through the `ccroute` name.
  /\bcli\.js\b/.test(joined);

// Deny whenever `blocked` is true, regardless of the tool's display name. The previous
// check additionally required `/shell/i.test(tool)`, so any tool NOT named something
// matching /shell/i (e.g. "Bash", "Execute", "Terminal", "Run") could invoke a blocked
// command even while `blocked` was already true — the tool-name gate was the bypass,
// not a meaningful restriction, since the blocked command list is what actually matters.
if (blocked) {
  process.stdout.write(
    JSON.stringify({
      continue: true,
      systemMessage: "Blocked nested ccroute from child role session",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "CCROUTE_CHILD=1 sessions must not invoke ccroute or commandcode-deal-orchestrator",
      },
    }),
  );
  process.exit(0);
}

process.stdout.write("{}\n");
