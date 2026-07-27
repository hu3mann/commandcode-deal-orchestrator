import { z } from "zod";

export const AGENT_OWNERSHIP_MARKER = "ccroute-managed-agent" as const;
export const MANAGED_AGENT_NAMES = [
  "ccroute-planner",
  "ccroute-reviewer",
  "ccroute-explorer",
] as const;
export type ManagedAgentName = (typeof MANAGED_AGENT_NAMES)[number];

export const AgentFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1).default("inherit"),
  permissionMode: z.string().optional(),
  tools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  delegation: z.boolean().optional(),
  ownershipMarker: z.string().optional(),
});
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export const AgentsRefreshStateSchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.enum(["project", "user"]),
  updatedAt: z.string(),
  liveCatalogInspected: z.boolean(),
  selectedIds: z.record(z.string()),
  notes: z.array(z.string()).default([]),
});
export type AgentsRefreshState = z.infer<typeof AgentsRefreshStateSchema>;
