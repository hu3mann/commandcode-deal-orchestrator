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

export function buildRoleStdin(packet: RolePacket): string {
  const prompt = loadRolePrompt(packet.role);
  const body = {
    role: packet.role,
    task: packet.task,
    constraints: packet.constraints ?? [],
    acceptance: packet.acceptance ?? [],
    plan: packet.plan ?? null,
    diffSummary: packet.diffSummary ?? null,
    testResults: packet.testResults ?? null,
    previous: packet.previous ?? null,
    riskSignals: packet.riskSignals ?? [],
    fileBoundaries: packet.fileBoundaries ?? [],
  };
  return `${prompt}\n\n## Packet\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}
