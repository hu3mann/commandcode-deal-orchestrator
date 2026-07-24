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

const tool = String(payload.tool_display_name || payload.tool_name || "");
const input = payload.tool_input || {};
const command = String(input.command || "");
const joined = `${command} ${(input.args || []).join(" ")}`.toLowerCase();

const blocked =
  /\bccroute\b/.test(joined) ||
  /commandcode-deal-orchestrator/.test(joined) ||
  /\bnpx\s+ccroute\b/.test(joined);

if (blocked && /shell/i.test(tool)) {
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
