export function assertSafeModelId(modelId: string): void {
  if (!modelId || modelId.length > 200) {
    throw new Error("Invalid model id");
  }
  if (modelId.trim().length === 0) {
    throw new Error("Model id must not be empty or whitespace-only");
  }
  if (/[\n\r\0;|&$`<>]/.test(modelId)) {
    throw new Error(`Model id contains forbidden characters: ${JSON.stringify(modelId)}`);
  }
  if (modelId.includes("..")) {
    throw new Error("Model id path traversal rejected");
  }
  // Model IDs become argv tokens (see buildCmdArgv: `--model <modelId>`). A value
  // beginning with `-` is not "a model name that happens to look odd" — it is an
  // argument-injection primitive against the child CommandCode CLI's own argv parser
  // (e.g. "--auto-accept", "--yolo", "-y" would each be parsed by `cmd` as a flag,
  // not as the value of `--model`). Reject any leading dash outright.
  if (modelId.startsWith("-")) {
    throw new Error(`Model id must not begin with '-': ${JSON.stringify(modelId)}`);
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
  if (options.extraArgs) {
    for (const arg of options.extraArgs) {
      if (typeof arg !== "string" || !arg) {
        throw new Error("Invalid extra argv entry");
      }
      if (/[\n\r\0]/.test(arg)) {
        throw new Error("extraArgs must not contain control characters");
      }
      if (arg === "--auto-accept" || arg === "--yolo" || arg.startsWith("--yolo=")) {
        throw new Error("extraArgs cannot inject write-bypass flags");
      }
      argv.push(arg);
    }
  }
  return argv;
}

export function warnUnsafeYolo(): string {
  return "WARNING: --unsafe-yolo enables CommandCode --yolo and bypasses permission prompts. Not enabled by config defaults.";
}
