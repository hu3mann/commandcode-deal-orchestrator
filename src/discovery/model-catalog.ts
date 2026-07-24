import { runCmdCapture } from "./commandcode-cli.js";

/**
 * Parse `cmd --list-models` text output into model IDs.
 * Live format lists full ids like deepseek/deepseek-v4-flash.
 */
export function parseListModelsOutput(text: string): string[] {
  const ids = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip headers / docs lines
    if (/^available models/i.test(trimmed)) continue;
    if (/^open source|^anthropic|^openai|^google|^sakana|^meta|^xai$/i.test(trimmed)) continue;
    if (/^pass the full id/i.test(trimmed)) continue;
    if (/^docs:/i.test(trimmed)) continue;
    if (/^cmd --model/i.test(trimmed)) continue;

    // First token is often the model id
    const m = trimmed.match(/^([a-zA-Z0-9_._-]+(?:\/[a-zA-Z0-9_._-]+)?)\b/);
    if (!m) continue;
    const id = m[1]!;
    // Filter noise words
    if (["Usage", "Options", "Commands", "Copy", "Docs"].includes(id)) continue;
    if (id.length < 3) continue;
    // Prefer ids that look like models
    if (id.includes("/") || /^(claude|gpt|grok|gemini)/i.test(id)) {
      ids.add(id);
    } else if (/^[a-z0-9.-]+$/i.test(id) && trimmed.length > id.length + 5) {
      // short names without slash sometimes appear; skip unless clearly a model line with description
      // keep only known-pattern short names
      if (/^(claude|gpt)-/.test(id)) ids.add(id);
    }
  }
  return [...ids].sort();
}

export function fetchLiveModelIds(cmdPath: string): { ids: string[]; error?: string } {
  const r = runCmdCapture(cmdPath, ["--list-models"]);
  if (r.status !== 0) {
    return { ids: [], error: r.stderr || `cmd --list-models exited ${r.status}` };
  }
  return { ids: parseListModelsOutput(r.stdout || r.stderr) };
}
