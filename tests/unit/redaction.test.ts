import { describe, expect, it } from "vitest";
import { hashPath, redactText } from "../../src/telemetry/redact.js";

// NOTE: every "secret" below is a clearly fake, non-functional placeholder
// (obviously fabricated suffixes like FAKEFAKEFAKE / xxxxxxxx). None of these
// are real credentials.

describe("redactText", () => {
  it("redacts a real-shaped Anthropic key (regression: hyphenated char class)", () => {
    // This is the exact defect: a class of [a-z0-9] stops at the first
    // hyphen, so a real key like sk-ant-api03-<...> was never redacted.
    const input = "key is sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234567890 do not share";
    const out = redactText(input);
    expect(out).not.toContain("sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234567890");
    expect(out).toContain("[REDACTED]");
  });

  it("confirms the OLD pattern would have failed (sanity check on the bug)", () => {
    const oldPattern = /sk-[a-z0-9]{10,}/gi;
    const key = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234567890";
    expect(key.match(oldPattern)).toBeNull();
  });

  it("redacts OpenAI-shaped keys, including sk-proj- form", () => {
    expect(redactText("token: sk-proj-FAKEFAKEFAKEFAKEFAKE1234567890")).not.toContain(
      "sk-proj-FAKEFAKEFAKEFAKEFAKE1234567890",
    );
    expect(redactText("legacy sk-FAKEFAKEFAKEFAKEFAKE1234567890abcd")).not.toContain(
      "sk-FAKEFAKEFAKEFAKEFAKE1234567890abcd",
    );
  });

  it("redacts xAI keys", () => {
    const out = redactText("xai-FAKEFAKEFAKEFAKEFAKE1234567890");
    expect(out).not.toContain("xai-FAKEFAKEFAKEFAKEFAKE1234567890");
  });

  it("redacts GitHub tokens (classic PAT, fine-grained PAT, and oauth/app prefixes)", () => {
    const ghp = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
    const gho = "gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
    const finePat = "github_pat_FAKEFAKEFAKEFAKEFAKE_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
    expect(redactText(`token=${ghp}`)).not.toContain(ghp);
    expect(redactText(`token=${gho}`)).not.toContain(gho);
    expect(redactText(`token=${finePat}`)).not.toContain(finePat);
  });

  it("redacts bearer tokens", () => {
    const out = redactText("Authorization: Bearer abc.def-ghi_123");
    expect(out).not.toContain("abc.def-ghi_123");
  });

  it("redacts generic Authorization headers (non-bearer schemes too)", () => {
    const out = redactText("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
  });

  it("redacts Cookie and Set-Cookie headers", () => {
    const out1 = redactText("Cookie: session=abc123; other=xyz");
    expect(out1).not.toContain("session=abc123");
    const out2 = redactText("Set-Cookie: sid=deadbeef; Path=/; HttpOnly");
    expect(out2).not.toContain("deadbeef");
  });

  it("redacts generic api-key / token / secret / credential assignments", () => {
    expect(redactText("api_key: FAKESECRETVALUE123")).not.toContain("FAKESECRETVALUE123");
    expect(redactText("apiKey=FAKESECRETVALUE123")).not.toContain("FAKESECRETVALUE123");
    expect(redactText("access_token: FAKESECRETVALUE123")).not.toContain("FAKESECRETVALUE123");
    expect(redactText("secret=FAKESECRETVALUE123")).not.toContain("FAKESECRETVALUE123");
    expect(redactText("credentials: FAKESECRETVALUE123")).not.toContain("FAKESECRETVALUE123");
  });

  it("redacts CommandCode-style env credentials via the generic token/secret rule", () => {
    // CommandCode has no single fixed literal credential prefix in this repo,
    // so it is covered by the generic token/secret/credential assignment
    // pattern rather than a dedicated literal.
    expect(redactText("CCROUTE_TOKEN=FAKESECRETVALUE123")).not.toContain("FAKESECRETVALUE123");
    expect(redactText("cc_api_key: FAKESECRETVALUE123")).not.toContain("FAKESECRETVALUE123");
  });

  it("redacts password assignments", () => {
    expect(redactText("password: hunter2fake")).not.toContain("hunter2fake");
    expect(redactText("password=hunter2fake")).not.toContain("hunter2fake");
  });

  it("redacts PEM private key blocks", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
      "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactText(`here is my key:\n${pem}\nthanks`);
    expect(out).not.toContain("FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE");
    expect(out).toContain("[REDACTED]");
  });

  it("leaves ordinary text alone (no over-aggressive false positives on plain prose)", () => {
    const prose = "Please review the pull request and update the changelog by Friday.";
    expect(redactText(prose)).toBe(prose);
  });

  it("is idempotent-ish and handles multiple distinct secrets in one string", () => {
    const input =
      "sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234567890 and password: hunter2fake and ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
    const out = redactText(input);
    expect(out).not.toContain("hunter2fake");
    expect(out).not.toContain("sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234567890");
    expect(out).not.toContain("ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE");
  });
});

describe("hashPath", () => {
  it("no longer returns the input unchanged (regression: old no-op)", () => {
    const p = "/Users/someone/secret-project";
    expect(hashPath(p)).not.toBe(p);
  });

  it("is deterministic for the same input", () => {
    const p = "/Users/someone/secret-project";
    expect(hashPath(p)).toBe(hashPath(p));
  });

  it("differs for different inputs", () => {
    expect(hashPath("/a/b/c")).not.toBe(hashPath("/a/b/d"));
  });

  it("does not embed the original path text in the output", () => {
    const p = "/Users/someone/very-identifiable-name";
    expect(hashPath(p)).not.toContain("someone");
    expect(hashPath(p)).not.toContain("very-identifiable-name");
  });
});
