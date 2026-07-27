import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backupSettings,
  hookIdentity,
  listManagedHookIdentities,
  loadSettings,
  mergeHooks,
  unmergeHooks,
  writeSettingsAtomic,
} from "../../src/install/settings-custody.js";
import { HOOK_OWNERSHIP_MARKER } from "../../src/install/types.js";

describe("settings custody", () => {
  it("preserves unknown keys, permissions, and unrelated hooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-settings-"));
    const path = join(dir, "settings.json");
    const original = {
      permissions: { allow: ["Shell(ls)"], defaultMode: "default" },
      taste: { learning: true },
      profile: { name: "operator" },
      hooks: {
        PreToolUse: [
          {
            matcher: "write",
            hooks: [{ type: "command", command: "echo user-hook", timeout: 1 }],
          },
        ],
      },
      customFutureKey: { nested: 1 },
    };
    writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);
    chmodSync(path, 0o600);

    const loaded = loadSettings(path);
    expect(loaded.parseError).toBeUndefined();
    expect(loaded.mode).toBe(0o600);

    const { data, identities } = mergeHooks(loaded.data!, [
      {
        event: "PreToolUse",
        matcher: "shell",
        command: `node /tmp/guard.mjs # ${HOOK_OWNERSHIP_MARKER}`,
      },
    ]);

    expect(data.permissions).toEqual(original.permissions);
    expect(data.taste).toEqual(original.taste);
    expect(data.profile).toEqual(original.profile);
    expect(data.customFutureKey).toEqual(original.customFutureKey);
    const hooks = data.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(JSON.stringify(hooks.PreToolUse)).toContain("user-hook");
    expect(identities).toHaveLength(1);

    const written = writeSettingsAtomic(path, data, { previousMode: 0o600 });
    expect(written.hash.length).toBe(64);
    // mode preserved (best effort on platforms that support it)
    const reloaded = loadSettings(path);
    expect(reloaded.mode).toBe(0o600);
  });

  it("dedupes managed hooks by stable identity", () => {
    const base = { hooks: {} };
    const spec = {
      event: "SessionStart" as const,
      command: `node /tmp/s.mjs # ${HOOK_OWNERSHIP_MARKER}`,
    };
    const once = mergeHooks(base, [spec]);
    const twice = mergeHooks(once.data, [spec]);
    const groups = (twice.data.hooks as Record<string, unknown[]>).SessionStart;
    const commands = JSON.stringify(groups);
    const count = (commands.match(/node \/tmp\/s\.mjs/g) ?? []).length;
    expect(count).toBe(1);
    expect(listManagedHookIdentities(twice.data)).toHaveLength(1);
  });

  it("unmerges only owned hooks", () => {
    const { data, identities } = mergeHooks(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "shell",
              hooks: [{ type: "command", command: "echo keep-me" }],
            },
          ],
        },
      },
      [
        {
          event: "PreToolUse",
          matcher: "shell",
          command: `node guard # ${HOOK_OWNERSHIP_MARKER}`,
        },
      ],
    );
    const cleaned = unmergeHooks(data, identities);
    const text = JSON.stringify(cleaned);
    expect(text).toContain("keep-me");
    expect(text).not.toContain("node guard");
  });

  it("refuses to treat malformed settings as mergeable", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-bad-settings-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, "{ not json");
    const loaded = loadSettings(path);
    expect(loaded.data).toBeNull();
    expect(loaded.parseError).toBeTruthy();
  });

  it("creates timestamped backups without overwriting source", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-bak-"));
    const settings = join(dir, "settings.json");
    const bakDir = join(dir, "backups");
    writeFileSync(settings, '{"a":1}\n');
    const bak = backupSettings(settings, bakDir);
    expect(bak).toBeTruthy();
    expect(existsSync(bak!)).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe('{"a":1}\n');
    mkdirSync(bakDir, { recursive: true });
  });

  it("builds stable hook identities", () => {
    const a = hookIdentity({
      event: "PreToolUse",
      matcher: "shell",
      command: "node  ./x.mjs",
    });
    const b = hookIdentity({
      event: "PreToolUse",
      matcher: "shell",
      command: "node ./x.mjs",
    });
    expect(a).toBe(b);
  });
});
