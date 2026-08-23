import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const { aiServantRoot, claudeDir, claudeCommandsDir, servantSkillsDir } = await import(
  "../src/core/paths.ts"
);

describe("ensureServantAssets", () => {
  test("ships goal as a core skill under the servant root", async () => {
    await ensureServantAssets();
    const target = join(servantSkillsDir(), "servant-goal", "SKILL.md");
    const s = await stat(target);
    expect(s.isFile()).toBe(true);
    const body = await readFile(target, "utf8");
    expect(body).toContain("name: servant-goal");
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
    const target = join(aiServantRoot(), "CLAUDE.md");
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
    // delegate is retired — its namespaced command must be removed, not resynced.
    expect(await Bun.file(retiredDelegate).exists()).toBe(false);
  });

  // A command that became a skill would otherwise linger from an older install and shadow it with
  // a stale body — the sync never deletes on its own, so each conversion is swept by name.
  test("sweeps every command that became a core skill", async () => {
    const commands = claudeCommandsDir();
    await mkdir(join(commands, "servant"), { recursive: true });
    const converted = ["goal", "lead", "extract-memories", "fine-tune", "recall"];
    // `handoff` converted under a different name (servant-skill-rework#8), so it is swept without a
    // `servant-handoff` skill ever existing — the command going away is the whole of its retirement.
    for (const name of [...converted, "handoff"]) {
      await writeFile(
        join(commands, "servant", `${name}.md`),
        "stale copy from an older servant\n",
      );
    }

    await ensureServantAssets();

    for (const name of [...converted, "handoff"]) {
      expect(await Bun.file(join(commands, "servant", `${name}.md`)).exists()).toBe(false);
    }
    for (const name of [...converted, "delegate"]) {
      expect(await Bun.file(join(servantSkillsDir(), `servant-${name}`, "SKILL.md")).exists()).toBe(
        true,
      );
    }
    // Nothing servant ships is a slash command any more.
    expect(await readdir(join(commands, "servant"))).toEqual([]);
  });

  test("ships extract-memories as a core skill", async () => {
    await ensureServantAssets();
    const extract = join(servantSkillsDir(), "servant-extract-memories", "SKILL.md");
    expect(await readFile(extract, "utf8")).toContain("--reconcile");
  });

  test("ships recall as a core skill, and retires the command it used to be", async () => {
    const retiredRecall = join(claudeCommandsDir(), "servant", "recall.md");
    await mkdir(dirname(retiredRecall), { recursive: true });
    await writeFile(retiredRecall, "stale copy from an older servant\n");

    await ensureServantAssets();

    const skill = await readFile(join(servantSkillsDir(), "servant-recall", "SKILL.md"), "utf8");
    expect(skill).toContain("name: servant-recall");
    expect(skill).toContain("servant recall");
    // Two copies of one instruction, one of them stale, is worse than either alone.
    expect(await Bun.file(retiredRecall).exists()).toBe(false);
  });

  // A skill nobody can invoke has not shipped, so the asset-sync path is asserted per command
  // rather than trusted — template changes are also inert until the binary is rebuilt.
  test("ships the /servant-lead initiative report", async () => {
    await ensureServantAssets();
    const lead = await readFile(join(servantSkillsDir(), "servant-lead", "SKILL.md"), "utf8");
    expect(lead).toContain("/servant-lead");
    // The join it reports from, and the rule that keeps redirecting safe.
    expect(lead).toContain("servant tasks --frontier");
    expect(lead).toContain("safe point");
  });

  // The judgment the CLI deliberately does not hold lives in this skill's prose, so the prose is
  // what has to be asserted: an edit that empties the source list leaves a manager that manages
  // nothing, and the CLI cannot fail in its place.
  test("ships the /servant-skills manager, and the judgment it carries", async () => {
    await ensureServantAssets();
    const manager = await readFile(join(servantSkillsDir(), "servant-skills", "SKILL.md"), "utf8");
    expect(manager).toContain("name: servant-skills");
    // The known-source list — a convenience that lives here and nowhere in `src/`.
    for (const source of [
      "anthropics/skills",
      "mattpocock/skills",
      "cursor/plugins",
      "obra/superpowers",
    ]) {
      expect(manager).toContain(source);
    }
    // The whole contract with the CLI, and no verb beyond it.
    for (const verb of ["catalog", "install", "enable", "disable", "check"]) {
      expect(manager).toContain(`servant skills ${verb}`);
    }
    // The four board-coupled skills are entries here, not servant's own.
    expect(manager).toContain("`to-spec`, `to-tickets`, `implement` and `code-review`");
    // Each drift state, and that a modified one is protected rather than repaired.
    for (const state of ["`clean`", "`modified`", "`missing`"]) expect(manager).toContain(state);
    expect(manager).toContain("--force");
    // The line the whole initiative rests on.
    expect(manager).toContain("Never put a skill's name in `src/`");
  });

  test("ships the /servant-delegate continuation skill", async () => {
    await ensureServantAssets();
    const delegate = await readFile(
      join(servantSkillsDir(), "servant-delegate", "SKILL.md"),
      "utf8",
    );
    expect(delegate).toContain("name: servant-delegate");
    // The board facts the rewrite had to keep while cutting the route table.
    expect(delegate).toContain("servant tasks --frontier");
    expect(delegate).toContain("servant ticket comment");
    expect(delegate).toContain("servant claim <N> --session <ws>-t<N>");
  });

  test("places .claude/ as a sibling of workspaces/ under the servant root", async () => {
    await ensureServantAssets();
    expect(claudeDir()).toBe(join(tmpRoot, ".claude"));
  });
});
