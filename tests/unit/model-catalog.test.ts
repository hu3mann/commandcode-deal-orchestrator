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

Google

google/gemini-3.6-flash              higher-quality coding
google/gemini-3.5-flash              Pro-level coding

Sakana

sakana/fugu-ultra                    multi-agent orchestration

Meta

meta/muse-spark-1.1                  agentic performance

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
    expect(ids).toContain("google/gemini-3.6-flash");
    expect(ids).toContain("sakana/fugu-ultra");
    expect(ids).toContain("meta/muse-spark-1.1");
    expect(ids).not.toContain("Docs");
    expect(ids).not.toContain("Google");
  });
});
