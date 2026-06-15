import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
const originalEnv = process.env.AI_SERVANT_ROOT;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-claude-setup-"));
  process.env.AI_SERVANT_ROOT = tmpRoot;
});

afterAll(async () => {
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AI_SERVANT_ROOT");
  else process.env.AI_SERVANT_ROOT = originalEnv;
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(tmpRoot, ".claude"), { recursive: true, force: true });
  await rm(join(tmpRoot, "CLAUDE.md"), { force: true });
});

const { ensureServantAssets } = await import("../src/core/claude-setup.ts");
const { aiServantRoot, claudeDir, claudeCommandsDir } = await import("../src/core/paths.ts");

describe("ensureServantAssets", () => {
  test("creates .claude/commands/delegate.md under the servant root", async () => {
    await ensureServantAssets();
    const target = join(claudeCommandsDir(), "delegate.md");
    const s = await stat(target);
    expect(s.isFile()).toBe(true);
    const body = await readFile(target, "utf8");
    expect(body).toContain("Agent Brief");
    expect(body).toContain("argument-hint");
  });

  test("creates .claude/commands/goal.md under the servant root", async () => {
    await ensureServantAssets();
    const target = join(claudeCommandsDir(), "goal.md");
    const s = await stat(target);
    expect(s.isFile()).toBe(true);
    const body = await readFile(target, "utf8");
    expect(body).toContain("GOAL.md");
    expect(body).toContain("servant:goal:unfilled");
  });

  test("creates CLAUDE.md at the servant root with workspace conventions", async () => {
    await ensureServantAssets();
    const target = join(aiServantRoot(), "CLAUDE.md");
    const s = await stat(target);
    expect(s.isFile()).toBe(true);
    const body = await readFile(target, "utf8");
    expect(body).toContain("Servant Workspace");
    expect(body).toContain("briefs/");
    expect(body).toContain("Agent Brief");
  });

  test("is idempotent and resyncs when content drifts", async () => {
    await ensureServantAssets();
    const target = join(claudeCommandsDir(), "delegate.md");
    const original = await readFile(target, "utf8");

    // user / drift modifies the file
    await writeFile(target, "tampered");

    await ensureServantAssets();
    const restored = await readFile(target, "utf8");
    expect(restored).toBe(original);
  });

  test("places .claude/ as a sibling of workspaces/ under the servant root", async () => {
    await ensureServantAssets();
    expect(claudeDir()).toBe(join(tmpRoot, ".claude"));
  });
});
