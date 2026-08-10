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
    expect(body).toContain("mattpocock");
    expect(body).toContain("servant tasks");
  });

  test("is idempotent and resyncs when content drifts", async () => {
    await ensureServantAssets();
    const target = join(claudeCommandsDir(), "servant", "goal.md");
    const original = await readFile(target, "utf8");

    // user / drift modifies the file
    await writeFile(target, "tampered");

    await ensureServantAssets();
    const restored = await readFile(target, "utf8");
    expect(restored).toBe(original);
  });

  test("removes pre-namespace flat command files on upgrade", async () => {
    // Simulate an install made before commands were namespaced under servant/, plus the retired
    // (namespaced) delegate command — both must be cleaned up on sync.
    const commands = claudeCommandsDir();
    await mkdir(join(commands, "servant"), { recursive: true });
    const legacyGoal = join(commands, "goal.md");
    const legacyDelegate = join(commands, "delegate.md");
    const retiredDelegate = join(commands, "servant", "delegate.md");
    await writeFile(legacyGoal, "old /goal");
    await writeFile(legacyDelegate, "old /delegate");
    await writeFile(retiredDelegate, "old /servant:delegate");

    await ensureServantAssets();

    expect(await Bun.file(legacyGoal).exists()).toBe(false);
    expect(await Bun.file(legacyDelegate).exists()).toBe(false);
    expect(await Bun.file(join(commands, "servant", "goal.md")).exists()).toBe(true);
    // delegate is retired — its namespaced command must be removed, not resynced.
    expect(await Bun.file(retiredDelegate).exists()).toBe(false);
  });

  test("ships the recall and extract-memories slash commands", async () => {
    await ensureServantAssets();
    const recall = join(claudeCommandsDir(), "servant", "recall.md");
    const extract = join(claudeCommandsDir(), "servant", "extract-memories.md");
    expect(await readFile(recall, "utf8")).toContain("/servant:recall");
    expect(await readFile(extract, "utf8")).toContain("--reconcile");
  });

  // A skill nobody can invoke has not shipped, so the asset-sync path is asserted per command
  // rather than trusted — template changes are also inert until the binary is rebuilt.
  test("ships the /servant:lead initiative report", async () => {
    await ensureServantAssets();
    const lead = await readFile(join(claudeCommandsDir(), "servant", "lead.md"), "utf8");
    expect(lead).toContain("/servant:lead");
    // The join it reports from, and the rule that keeps redirecting safe.
    expect(lead).toContain("servant tasks --frontier");
    expect(lead).toContain("safe point");
  });

  test("ships the /servant:handoff continuation skill", async () => {
    await ensureServantAssets();
    const handoff = await readFile(join(claudeCommandsDir(), "servant", "handoff.md"), "utf8");
    expect(handoff).toContain("/servant:handoff");
    expect(handoff).toContain("servant tasks --frontier");
    expect(handoff).toContain("disable-model-invocation: true");
  });

  test("places .claude/ as a sibling of workspaces/ under the servant root", async () => {
    await ensureServantAssets();
    expect(claudeDir()).toBe(join(tmpRoot, ".claude"));
  });
});
