export {
  installLifecycle,
  statusLifecycle,
  updateLifecycle,
  repairLifecycle,
  uninstallLifecycle,
  formatLifecycleResult,
} from "./lifecycle.js";
export { resolveInstallPaths, resolveScope, resolveModSource } from "./paths.js";
export {
  loadSettings,
  mergeHooks,
  unmergeHooks,
  writeSettingsAtomic,
  backupSettings,
  hookIdentity,
  normalizeCommand,
  listManagedHookIdentities,
} from "./settings-custody.js";
export {
  probeModManager,
  modAdd,
  modRemove,
  modUpdate,
  modList,
  sourcesFromSettingsText,
  settingsMentionsSource,
} from "./mod-manager.js";
export { readManifest, writeManifestAtomic } from "./manifest.js";
export { sha256File, sha256Text, sha256Buffer } from "./hash.js";
export type {
  InstallCliOptions,
  InstallManifest,
  InstallScope,
  LifecycleResult,
  PlannedAction,
  InstallConflict,
  ManagedFileEntry,
} from "./types.js";
export {
  INSTALL_OWNERSHIP_MARKER,
  HOOK_OWNERSHIP_MARKER,
  MANIFEST_FILENAME,
  InstallError,
  InstallManifestSchema,
} from "./types.js";
