import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../config/defaults.js";
import type { RoleName } from "./roles.js";

export function loadRolePrompt(role: RoleName): string {
  const path = join(packageRoot(), "prompts", `${role}.md`);
  try {
    return readFileSync(path, "utf8");
  } catch {
    return `You are the ${role} role. Return a machine-readable envelope.`;
  }
}

export interface RolePacket {
  role: RoleName;
  task: string;
  constraints?: string[];
  acceptance?: string[];
  plan?: unknown;
  diffSummary?: string;
  testResults?: string;
  previous?: unknown;
  riskSignals?: string[];
  fileBoundaries?: string[];
}

/** Thrown by buildRoleStdin when a packet cannot be brought under maxBytes even after
 * truncating its large free-text fields (defect §3: maxPromptBytes was defined but never
 * enforced, so a role packet had no size bound at all before reaching a child's stdin). */
export class RolePacketTooLargeError extends Error {
  constructor(
    public readonly role: RoleName,
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `Role packet for "${role}" is ${actualBytes} bytes, exceeding maxPromptBytes=${maxBytes}. Reduce the plan/previous/diff payload size before retrying.`,
    );
    this.name = "RolePacketTooLargeError";
  }
}

export interface BuildRoleStdinOptions {
  /** Hard cap on the full stdin payload, in bytes (config: security.maxPromptBytes).
   * Large free-text fields (diffSummary, testResults) are truncated first; if the packet
   * is still over budget after truncation, buildRoleStdin throws RolePacketTooLargeError
   * rather than silently sending an oversized payload to a child process's stdin. */
  maxBytes?: number;
}

function clampField(value: string | null | undefined, limitBytes: number): string | null {
  if (value == null) return null;
  if (Buffer.byteLength(value, "utf8") <= limitBytes) return value;
  const truncatedAt = Buffer.byteLength(value, "utf8") - limitBytes;
  return `${value.slice(0, limitBytes)}\n...[truncated ${truncatedAt} bytes to respect maxPromptBytes]`;
}

export function buildRoleStdin(packet: RolePacket, options?: BuildRoleStdinOptions): string {
  const prompt = loadRolePrompt(packet.role);
  const maxBytes = options?.maxBytes;
  // Reserve roughly 40% of the overall budget for each of the two large free-text fields
  // so neither one alone can exhaust the packet; the rest (task/plan/previous/etc.) is
  // expected to be comparatively small.
  const fieldCap = maxBytes
    ? Math.max(2_000, Math.floor(maxBytes * 0.4))
    : Number.POSITIVE_INFINITY;

  const body = {
    role: packet.role,
    task: packet.task,
    constraints: packet.constraints ?? [],
    acceptance: packet.acceptance ?? [],
    plan: packet.plan ?? null,
    diffSummary: clampField(packet.diffSummary, fieldCap),
    testResults: clampField(packet.testResults, fieldCap),
    previous: packet.previous ?? null,
    riskSignals: packet.riskSignals ?? [],
    fileBoundaries: packet.fileBoundaries ?? [],
  };
  const stdin = `${prompt}\n\n## Packet\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;

  if (maxBytes !== undefined) {
    const actual = Buffer.byteLength(stdin, "utf8");
    if (actual > maxBytes) {
      throw new RolePacketTooLargeError(packet.role, actual, maxBytes);
    }
  }
  return stdin;
}
