import { z } from "zod";

export const INSTALL_OWNERSHIP_MARKER = "ccroute-managed" as const;
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_FILENAME = "ccroute-install-manifest.json" as const;
export const HOOK_OWNERSHIP_MARKER = "ccroute-managed-hook" as const;

export type InstallScope = "project" | "user";

export type InstallationStatus =
  | "complete"
  | "partial"
  | "dry-run"
  | "uninstalled"
  | "conflict"
  | "error";

export const ManagedFileEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
  method: z.enum(["copy", "mod-manager", "settings-merge", "symlink"]),
  sourceArtifact: z.string().min(1),
  ownershipMarker: z.string().min(1),
});
export type ManagedFileEntry = z.infer<typeof ManagedFileEntrySchema>;

export const ManagedSettingsEntrySchema = z.object({
  settingsPath: z.string().min(1),
  identity: z.string().min(1),
  event: z.string().optional(),
  matcher: z.string().optional(),
  command: z.string().optional(),
  ownershipMarker: z.string().min(1),
});
export type ManagedSettingsEntry = z.infer<typeof ManagedSettingsEntrySchema>;

export const InstallManifestSchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.enum(["project", "user"]),
  packageVersion: z.string(),
  commandCodeVersion: z.string(),
  modApiVersion: z.string(),
  installedAt: z.string(),
  updatedAt: z.string(),
  modSource: z.string(),
  managedFiles: z.array(ManagedFileEntrySchema),
  managedSettingsEntries: z.array(ManagedSettingsEntrySchema),
  settingsBeforeHash: z.string(),
  settingsAfterHash: z.string(),
  backupPath: z.string(),
  installationStatus: z.enum([
    "complete",
    "partial",
    "dry-run",
    "uninstalled",
    "conflict",
    "error",
  ]),
  options: z
    .object({
      skill: z.boolean().optional(),
      hooks: z.boolean().optional(),
      installMemory: z.boolean().optional(),
      agents: z.boolean().optional(),
    })
    .optional(),
});
export type InstallManifest = z.infer<typeof InstallManifestSchema>;

export interface InstallCliOptions {
  project?: boolean;
  user?: boolean;
  dryRun?: boolean;
  force?: boolean;
  skill?: boolean;
  hooks?: boolean;
  installMemory?: boolean;
  /** Uninstall-only: remove managed AGENTS.md memory block */
  removeMemory?: boolean;
  /** Install bounded role agents (default true on install) */
  agents?: boolean;
  json?: boolean;
  /** Absolute project root (default: cwd). Test seam. */
  projectRoot?: string;
  /** Absolute home directory (default: os.homedir()). Test seam. */
  homeDir?: string;
  /** Override cmd path. Test seam. */
  cmdPath?: string | null;
  /** Override package root. Test seam. */
  packageRoot?: string;
  /** Override mod source path or npm/git pin. Test seam. */
  modSource?: string;
  /** Injected env for subprocess + path resolution. */
  env?: NodeJS.ProcessEnv;
}

export interface PlannedAction {
  kind:
    | "mod-add"
    | "mod-remove"
    | "mod-update"
    | "copy-file"
    | "remove-file"
    | "settings-merge"
    | "settings-unmerge"
    | "write-manifest"
    | "remove-manifest"
    | "backup-settings"
    | "skip";
  target: string;
  detail?: string;
  destructive?: boolean;
}

export interface InstallConflict {
  path: string;
  reason:
    | "user-modified"
    | "hash-mismatch"
    | "unrelated-settings-changed"
    | "malformed-settings"
    | "missing-mod-manager"
    | "scope-conflict"
    | "stale-manifest"
    | "external-settings-drift";
  message: string;
}

export interface LifecycleResult {
  ok: boolean;
  operation: "install" | "status" | "update" | "repair" | "uninstall";
  scope: InstallScope;
  dryRun: boolean;
  actions: PlannedAction[];
  conflicts: InstallConflict[];
  manifest: InstallManifest | null;
  messages: string[];
  error?: string;
  exitHint?: "usage" | "config" | "conflict" | "subprocess" | "ok";
}

export class InstallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}
