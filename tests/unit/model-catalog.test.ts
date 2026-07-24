import { describe, expect, it } from "vitest";
import { parseListModelsOutput } from "../../src/discovery/model-catalog.js";

const sample = `
Available models  ·  47 models

Open Source

deepseek/deepseek-v4-pro             hybrid-attention
deepseek/deepseek-v4-flash           fast
xiaomi/mimo-v2.5-pro                 high-capability
minimaxai/minimax-m3                 frontier
xai/grok-4.5                         smartest
claude-sonnet-5                      best combo

Pass the full id, or just the short name after the last "/":
cmd --model moonshotai/kimi-k2.5

Docs:  https://commandcode.ai/docs/reference/cli/models
`;

describe("model catalog parse", () => {
  it("extracts model ids", () => {
    const ids = parseListModelsOutput(sample);
    expect(ids).toContain("deepseek/deepseek-v4-flash");
    expect(ids).toContain("xai/grok-4.5");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).not.toContain("Docs");
  });
});
