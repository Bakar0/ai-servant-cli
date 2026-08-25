// The foreign-source scan: what a session can invoke that the servant store does not own.
//
// Every fixture here is a real `~/.claude` layout in a temp dir, reached through
// `CLAUDE_CONFIG_DIR`, because the whole value of this module is that it reads the layout Claude
// Code actually uses — a mocked reader would only prove the mock.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ForeignSkill,
  findCollisions,
  listForeignSkills,
} from "../src/core/foreign-skills.ts";

let claudeHome: string;
let priorClaudeConfigDir: string | undefined;

beforeAll(async () => {
  claudeHome = await mkdtemp(join(tmpdir(), "servant-foreign-"));
  priorClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
});

afterAll(async () => {
  if (priorClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfigDir;
  await rm(claudeHome, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(join(claudeHome, "plugins"), { recursive: true, force: true });
  await rm(join(claudeHome, "skills"), { recursive: true, force: true });
  await rm(join(claudeHome, "settings.json"), { force: true });
});

async function writeSkill(
  dir: string,
  name: string,
  opts: { description?: string; disableModelInvocation?: boolean } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${opts.description ?? `what ${name} is for`}`,
    ...(opts.disableModelInvocation ? ["disable-model-invocation: true"] : []),
    "---",
    "",
    `# ${name}`,
  ];
  await writeFile(join(dir, "SKILL.md"), `${lines.join("\n")}\n`);
}

/** Register a plugin the way Claude Code does: an install record plus a cache directory. */
async function installPlugin(opts: {
  plugin: string;
  marketplace: string;
  version?: string;
  scope?: string;
  /** Each skill's path below the install dir — the nesting is the plugin's choice, not ours. */
  skills: string[];
  disableModelInvocation?: string[];
  enabled?: boolean | undefined;
}): Promise<string> {
  const version = opts.version ?? "1.0.0";
  const installPath = join(claudeHome, "plugins", "cache", opts.marketplace, opts.plugin, version);
  for (const rel of opts.skills) {
    const name = rel.split("/").pop() ?? rel;
    await writeSkill(join(installPath, rel), name, {
      disableModelInvocation: opts.disableModelInvocation?.includes(name) ?? false,
    });
  }

  const id = `${opts.plugin}@${opts.marketplace}`;
  const recordPath = join(claudeHome, "plugins", "installed_plugins.json");
  const existing = await Bun.file(recordPath)
    .json()
    .catch(() => ({ version: 2, plugins: {} }));
  existing.plugins[id] = [
    { scope: opts.scope ?? "user", installPath, version, installedAt: "2026-01-01T00:00:00.000Z" },
  ];
  await mkdir(join(claudeHome, "plugins"), { recursive: true });
  await writeFile(recordPath, JSON.stringify(existing, null, 2));

  if (opts.enabled !== undefined) {
    const settingsPath = join(claudeHome, "settings.json");
    const settings = await Bun.file(settingsPath)
      .json()
      .catch(() => ({}));
    settings.enabledPlugins = { ...settings.enabledPlugins, [id]: opts.enabled };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }
  return installPath;
}

const byName = (skills: ForeignSkill[]): string[] => skills.map((s) => s.name).sort();

describe("listForeignSkills", () => {
  test("reports nothing when there is no plugin and no personal skills directory", async () => {
    expect(await listForeignSkills()).toEqual([]);
  });

  test("finds a personal skill in ~/.claude/skills, with its own directory as the origin", async () => {
    await writeSkill(join(claudeHome, "skills", "hand-installed"), "hand-installed", {
      description: "something the user put there",
    });

    const found = await listForeignSkills();
    expect(found).toHaveLength(1);
    const skill = found[0] as ForeignSkill;
    expect(skill.name).toBe("hand-installed");
    expect(skill.invocation).toBe("hand-installed");
    expect(skill.origin.kind).toBe("personal");
    expect(skill.description).toBe("something the user put there");
    expect(skill.modelInvocable).toBe(true);
  });

  test("finds a plugin's skills at whatever depth the plugin nests them", async () => {
    await installPlugin({
      plugin: "deep",
      marketplace: "market",
      skills: ["skills/engineering/one", "skills/productivity/two", "skills/three"],
      enabled: true,
    });

    expect(byName(await listForeignSkills())).toEqual(["one", "three", "two"]);
  });

  test("namespaces a plugin skill's invocation as <plugin>:<name>", async () => {
    await installPlugin({
      plugin: "kit",
      marketplace: "market",
      skills: ["skills/review"],
      enabled: true,
    });

    const skill = (await listForeignSkills())[0] as ForeignSkill;
    expect(skill.invocation).toBe("kit:review");
    expect(skill.origin).toMatchObject({
      kind: "plugin",
      plugin: "kit",
      marketplace: "market",
      id: "kit@market",
      scope: "user",
    });
  });

  test("omits a disabled plugin entirely", async () => {
    await installPlugin({
      plugin: "off",
      marketplace: "market",
      skills: ["skills/gone"],
      enabled: false,
    });

    expect(await listForeignSkills()).toEqual([]);
  });

  test("treats a plugin absent from enabledPlugins as enabled — that is how a managed one arrives", async () => {
    await installPlugin({
      plugin: "policy",
      marketplace: "org",
      scope: "managed",
      skills: ["skills/mandated"],
      enabled: undefined,
    });

    const found = await listForeignSkills();
    expect(byName(found)).toEqual(["mandated"]);
    expect(found[0]?.origin).toMatchObject({ scope: "managed" });
  });

  test("ignores a cached plugin directory with no install record — nothing reaches a session from it", async () => {
    const orphan = join(claudeHome, "plugins", "cache", "market", "stale", "9.9.9");
    await writeSkill(join(orphan, "skills", "ghost"), "ghost");

    expect(await listForeignSkills()).toEqual([]);
  });

  test("separates reachable from model-visible instead of conflating them", async () => {
    await installPlugin({
      plugin: "mixed",
      marketplace: "market",
      skills: ["skills/shown", "skills/hidden"],
      disableModelInvocation: ["hidden"],
      enabled: true,
    });

    const found = await listForeignSkills();
    expect(byName(found)).toEqual(["hidden", "shown"]);
    expect(found.find((s) => s.name === "hidden")?.modelInvocable).toBe(false);
    expect(found.find((s) => s.name === "shown")?.modelInvocable).toBe(true);
  });

  test("does not walk a plugin's node_modules", async () => {
    const installPath = await installPlugin({
      plugin: "bundled",
      marketplace: "market",
      skills: ["skills/real"],
      enabled: true,
    });
    await writeSkill(join(installPath, "node_modules", "dep", "skills", "vendored"), "vendored");

    expect(byName(await listForeignSkills())).toEqual(["real"]);
  });

  test("charges a model-visible skill for its description and a hidden one for nothing", async () => {
    await installPlugin({
      plugin: "priced",
      marketplace: "market",
      skills: ["skills/loud", "skills/quiet"],
      disableModelInvocation: ["quiet"],
      enabled: true,
    });

    const found = await listForeignSkills();
    expect(found.find((s) => s.name === "loud")?.approxTokens).toBeGreaterThan(0);
    expect(found.find((s) => s.name === "quiet")?.approxTokens).toBe(0);
  });

  test("survives a malformed install record rather than failing the listing", async () => {
    await mkdir(join(claudeHome, "plugins"), { recursive: true });
    await writeFile(join(claudeHome, "plugins", "installed_plugins.json"), "{ not json");
    await writeSkill(join(claudeHome, "skills", "still-here"), "still-here");

    expect(byName(await listForeignSkills())).toEqual(["still-here"]);
  });
});

describe("findCollisions", () => {
  const foreign = (name: string, invocation: string): ForeignSkill => ({
    name,
    invocation,
    dir: `/tmp/${name}`,
    origin: {
      kind: "plugin",
      id: "kit@market",
      plugin: "kit",
      marketplace: "market",
      scope: "user",
      version: "1.0.0",
      installPath: "/tmp",
    },
    description: "",
    modelInvocable: true,
    approxTokens: 10,
  });

  test("pairs a foreign skill with a store skill of the same bare name", () => {
    const collisions = findCollisions(
      [{ name: "code-review", source: "owner/repo", enabled: true }],
      [foreign("code-review", "kit:code-review"), foreign("wizard", "kit:wizard")],
    );

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      name: "code-review",
      foreignInvocation: "kit:code-review",
      storeSources: ["owner/repo"],
    });
  });

  test("names every store source that shares the colliding name", () => {
    const collisions = findCollisions(
      [
        { name: "tdd", source: "a/one", enabled: true },
        { name: "tdd", source: "b/two", enabled: true },
      ],
      [foreign("tdd", "kit:tdd")],
    );

    expect(collisions[0]?.storeSources).toEqual(["a/one", "b/two"]);
  });

  test("a disabled store skill is not a collision — it is not in the session to be confused with", () => {
    expect(
      findCollisions(
        [{ name: "code-review", source: "owner/repo", enabled: false }],
        [foreign("code-review", "kit:code-review")],
      ),
    ).toEqual([]);
  });

  test("marks a collision contested only when the agent is shown the foreign twin", () => {
    const hidden = { ...foreign("tdd", "kit:tdd"), modelInvocable: false };
    const [shown, inert] = [
      findCollisions(
        [{ name: "tdd", source: "a/one", enabled: true }],
        [foreign("tdd", "kit:tdd")],
      ),
      findCollisions([{ name: "tdd", source: "a/one", enabled: true }], [hidden]),
    ];
    expect(shown[0]?.competing).toBe(true);
    expect(inert[0]?.competing).toBe(false);
  });

  test("reports no collision when the names do not meet", () => {
    expect(
      findCollisions(
        [{ name: "implement", source: "a/one", enabled: true }],
        [foreign("wizard", "k:wizard")],
      ),
    ).toEqual([]);
  });
});
