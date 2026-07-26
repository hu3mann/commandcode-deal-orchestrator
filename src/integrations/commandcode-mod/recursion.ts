/**
 * Mod-level recursion defence (defence-in-depth).
 * Primary control remains assertCcrouteEntryAllowed in the ccroute binary.
 *
 * Uses parsed executable identity rather than naive substring-only matching.
 */

export interface ToolInvocation {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ParsedCommand {
  executable: string;
  args: string[];
  raw: string;
}

const CCROUTE_BIN_NAMES = new Set([
  "ccroute",
  "ccroute.cmd",
  "ccroute.exe",
  "commandcode-deal-orchestrator",
  "commandcode-deal-orchestrator.cmd",
  "commandcode-deal-orchestrator.exe",
]);

/**
 * Parse a shell-ish command string into executable + args without executing it.
 * Handles simple quoting; does not expand variables (variables that rename the
 * binary can bypass this layer — binary guard remains authoritative).
 */
export function parseCommandLine(command: string): ParsedCommand {
  const raw = command.trim();
  if (!raw) return { executable: "", args: [], raw };
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  const [executable = "", ...args] = tokens;
  return { executable, args, raw };
}

function basename(pathLike: string): string {
  const norm = pathLike.replace(/\\/g, "/");
  const parts = norm.split("/");
  return parts[parts.length - 1] || pathLike;
}

function isNodeRuntime(exec: string): boolean {
  const base = basename(exec).toLowerCase();
  return base === "node" || base === "nodejs" || base.startsWith("node.");
}

function isNpmRunner(exec: string): boolean {
  const base = basename(exec).toLowerCase();
  return base === "npm" || base === "npx" || base === "pnpm" || base === "yarn" || base === "bun";
}

/** True when the resolved command identity is a ccroute entry. */
export function isCcrouteInvocation(parsed: ParsedCommand): boolean {
  const execBase = basename(parsed.executable).toLowerCase();
  if (CCROUTE_BIN_NAMES.has(execBase)) return true;

  // commandcode-deal-orchestrator package name via npm exec / npx
  if (isNpmRunner(parsed.executable)) {
    const joined = parsed.args.map((a) => a.toLowerCase());
    // npm exec ccroute | npx ccroute | npm exec commandcode-deal-orchestrator
    for (let i = 0; i < joined.length; i++) {
      const a = joined[i]!;
      if (a === "ccroute" || a === "commandcode-deal-orchestrator") return true;
      if ((a === "exec" || a === "x") && joined[i + 1] === "ccroute") return true;
      if ((a === "exec" || a === "x") && joined[i + 1] === "commandcode-deal-orchestrator")
        return true;
    }
  }

  // node <path-to-ccroute-entry>
  if (isNodeRuntime(parsed.executable)) {
    for (const arg of parsed.args) {
      const lower = arg.toLowerCase().replace(/\\/g, "/");
      if (lower.endsWith("/cli.js") || lower.endsWith("/cli.ts") || lower.endsWith("\\cli.js")) {
        // Prefer paths that look like this package's entry, not arbitrary cli.js
        if (
          lower.includes("commandcode-deal-orchestrator") ||
          lower.includes("/dist/cli.") ||
          lower.includes("ccroute") ||
          /(?:^|\/)cli\.(js|ts)$/.test(lower)
        ) {
          return true;
        }
      }
      if (lower.includes("commandcode-deal-orchestrator") && lower.includes("cli")) return true;
    }
  }

  return false;
}

/**
 * Extract command text from common tool input shapes (shell_command, Bash, etc.).
 */
export function extractCommandText(input: Record<string, unknown>): string {
  const candidates = ["command", "cmd", "script", "code", "input"];
  for (const key of candidates) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  if (Array.isArray(input.args)) {
    const args = input.args.filter((a): a is string => typeof a === "string");
    if (args.length) return args.join(" ");
  }
  return "";
}

export function shouldBlockChildCcroute(
  env: NodeJS.ProcessEnv,
  invocation: ToolInvocation,
): { block: boolean; reason?: string } {
  if (env.CCROUTE_CHILD !== "1") return { block: false };

  const commandText = extractCommandText(invocation.input);
  if (!commandText) return { block: false };

  const parsed = parseCommandLine(commandText);
  if (!isCcrouteInvocation(parsed)) {
    // Also check argv-style tool inputs: { command: "node", args: ["dist/cli.js"] }
    const exec =
      typeof invocation.input.command === "string" ? invocation.input.command : parsed.executable;
    const args = Array.isArray(invocation.input.args)
      ? invocation.input.args.filter((a): a is string => typeof a === "string")
      : parsed.args;
    if (!isCcrouteInvocation({ executable: exec, args, raw: commandText })) {
      return { block: false };
    }
  }

  return {
    block: true,
    reason:
      "CCROUTE_CHILD=1 sessions must not invoke ccroute, commandcode-deal-orchestrator, or its CLI entry",
  };
}
