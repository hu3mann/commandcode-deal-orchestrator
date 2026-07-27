import { join } from "node:path";
import { stateDir as defaultStateDir } from "../config/loader.js";

export function refreshStatePath(stateRoot?: string): string {
  return join(stateRoot ?? defaultStateDir(), "refresh-state.json");
}

export function refreshLogsDir(stateRoot?: string): string {
  return join(stateRoot ?? defaultStateDir(), "refresh-logs");
}

export function launchdLabel(): string {
  return "ai.commandcode.ccroute.refresh";
}

export function launchdPlistPath(homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? "";
  return join(home, "Library", "LaunchAgents", `${launchdLabel()}.plist`);
}
