#!/usr/bin/env node
/**
 * SessionStart hook: inject bounded child-role context when CCROUTE_CHILD=1.
 */
import { readFileSync } from "node:fs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Consume stdin fully
void readStdin();

if (process.env.CCROUTE_CHILD !== "1") {
  process.stdout.write("{}\n");
  process.exit(0);
}

const role = process.env.CCROUTE_ROLE || "unknown";
const runId = process.env.CCROUTE_RUN_ID || "unknown";
const depth = process.env.CCROUTE_DEPTH || "1";

const ctx = [
  "You are a bounded ccroute role process.",
  `Role: ${role}`,
  `Run ID: ${runId}`,
  `Depth: ${depth}`,
  "Do not invoke ccroute or launch another CommandCode orchestration run.",
  "Return the required BEGIN_CCROUTE_RESULT envelope when asked.",
].join(" ");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ctx,
    },
  }),
);
