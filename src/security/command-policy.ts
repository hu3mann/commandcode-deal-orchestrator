export function assertSafeModelId(modelId: string): void {
  if (!modelId || modelId.length > 200) {
    throw new Error("Invalid model id");
  }
  if (/[\n\r\0;|&$`<>]/.test(modelId)) {
    throw new Error(`Model id contains forbidden characters: ${JSON.stringify(modelId)}`);
  }
  if (modelId.includes("..")) {
    throw new Error("Model id path traversal rejected");
  }
}

export function buildCmdArgv(options: {
  model: string;
  print?: boolean;
  plan?: boolean;
  autoAccept?: boolean;
  unsafeYolo?: boolean;
  maxTurns?: number;
  skipOnboarding?: boolean;
  trust?: boolean;
  outputFormat?: "text" | "json";
  extraArgs?: string[];
}): string[] {
  assertSafeModelId(options.model);
  const argv: string[] = [];
  if (options.print !== false) argv.push("--print");
  argv.push("--model", options.model);
  if (options.plan) argv.push("--plan");
  if (options.autoAccept) argv.push("--auto-accept");
  if (options.unsafeYolo) {
    argv.push("--yolo");
  }
  if (options.maxTurns !== undefined) {
    argv.push("--max-turns", String(options.maxTurns));
  }
  if (options.skipOnboarding !== false) argv.push("--skip-onboarding");
  if (options.trust) argv.push("--trust");
  if (options.outputFormat) argv.push("--output-format", options.outputFormat);
  if (options.extraArgs) argv.push(...options.extraArgs);
  return argv;
}

export function warnUnsafeYolo(): string {
  return "WARNING: --unsafe-yolo enables CommandCode --yolo and bypasses permission prompts. Not enabled by config defaults.";
}
