import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-claude-setup-"));
  setRootOverride(tmpRoot);
});

afterAll(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(tmpRoot, ".claude"), { recursive: true, force: true });
  await rm(join(tmpRoot, "CLAUDE.md"), { force: true });
});

const { ensureServantAssets } = await import("../src/core/claude-setup.ts");
const { aiServantRoot, claudeDir, claudeCommandsDir } = await import("../src/core/paths.ts");

describe("ensureServantAssets", () => {
  test("creates .claude/commands/servant/delegate.md under the servant root", async () => {
    await ensureServantAssets();
    const target = join(claudeCommandsDir(), "servant", "delegate.md");
    const s = await stat(target);
    expect(s.isFile()).toBe(true);
    const body = await readFile(target, "utf8");
    expect(body).toContain("Agent Brief");
    expect(body).toContain("argument-hint");
  });

  test("creates .claude/commands/servant/goal.md under the servant root", async () => {
    await ensureServantAssets();
    const target = join(claudeCommandsDir(), "servant", "goal.md");
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
    const target = join(claudeCommandsDir(), "servant", "delegate.md");
    const original = await readFile(target, "utf8");

    // user / drift modifies the file
    await writeFile(target, "tampered");

    await ensureServantAssets();
    const restored = await readFile(target, "utf8");
    expect(restored).toBe(original);
  });

  test("removes pre-namespace flat command files on upgrade", async () => {
    // Simulate an install made before commands were namespaced under servant/.
    const commands = claudeCommandsDir();
    await mkdir(commands, { recursive: true });
    const legacyGoal = join(commands, "goal.md");
    const legacyDelegate = join(commands, "delegate.md");
    await writeFile(legacyGoal, "old /goal");
    await writeFile(legacyDelegate, "old /delegate");

    await ensureServantAssets();

    expect(await Bun.file(legacyGoal).exists()).toBe(false);
    expect(await Bun.file(legacyDelegate).exists()).toBe(false);
    expect(await Bun.file(join(commands, "servant", "goal.md")).exists()).toBe(true);
    expect(await Bun.file(join(commands, "servant", "delegate.md")).exists()).toBe(true);
  });

  test("ships the recall and extract-memories slash commands", async () => {
    await ensureServantAssets();
    const recall = join(claudeCommandsDir(), "servant", "recall.md");
    const extract = join(claudeCommandsDir(), "servant", "extract-memories.md");
    expect(await readFile(recall, "utf8")).toContain("/servant:recall");
    expect(await readFile(extract, "utf8")).toContain("--reconcile");
  });

  test("places .claude/ as a sibling of workspaces/ under the servant root", async () => {
    await ensureServantAssets();
    expect(claudeDir()).toBe(join(tmpRoot, ".claude"));
  });
});
