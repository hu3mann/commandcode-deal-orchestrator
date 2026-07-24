import {
  type CmdProbe,
  type CmdStatus,
  getCmdStatus,
  probeCommandCode,
} from "./commandcode-cli.js";
import { fetchLiveModelIds } from "./model-catalog.js";

export interface CapabilityReport {
  nodeVersion: string;
  cmd: CmdProbe;
  status: CmdStatus | null;
  modelIds: string[];
  modelListError?: string;
  supportedFlags: {
    print: boolean;
    model: boolean;
    plan: boolean;
    autoAccept: boolean;
    listModels: boolean;
    skipOnboarding: boolean;
    yolo: boolean;
  };
  contradictions: string[];
}

export function probeCapabilities(cmdPath?: string): CapabilityReport {
  const cmd = probeCommandCode(cmdPath);
  const help = cmd.helpSnippet ?? "";
  const status = cmd.path ? getCmdStatus(cmd.path) : null;
  const live = cmd.path ? fetchLiveModelIds(cmd.path) : { ids: [] as string[], error: "no cmd" };

  const contradictions: string[] = [];
  if (!cmd.path) contradictions.push("cmd not found on PATH");
  if (cmd.path && !help.includes("--print") && !help.includes("-p")) {
    contradictions.push("headless --print not found in help");
  }
  if (cmd.path && !help.includes("--model") && !help.includes("-m")) {
    contradictions.push("--model not found in help");
  }

  return {
    nodeVersion: process.version,
    cmd,
    status,
    modelIds: live.ids,
    modelListError: live.error,
    supportedFlags: {
      print: help.includes("--print") || help.includes("-p"),
      model: help.includes("--model") || help.includes("-m"),
      plan: help.includes("--plan"),
      autoAccept: help.includes("--auto-accept"),
      listModels: help.includes("--list-models"),
      skipOnboarding: help.includes("--skip-onboarding"),
      yolo: help.includes("--yolo"),
    },
    contradictions,
  };
}
