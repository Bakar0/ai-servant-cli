import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  ENABLED_SKILL_PREFIX,
  enabledSkillDir,
  setRootOverride,
  skillStoreDir,
  skillsManifestPath,
  userClaudeSkillsDir,
} from "../src/core/paths.ts";
import {
  checkForUpdates,
  disableSkill,
  discoverSkills,
  enableSkill,
  hashSkillDir,
  installFromSource,
  listSkills,
  parseSource,
  readManifest,
  skillName,
} from "../src/core/skills.ts";

let scratch: string;
let servantRoot: string;
let claudeHome: string;
let alpha: string;
let beta: string;
let priorClaudeConfigDir: string | undefined;

async function git(repo: string, ...args: string[]): Promise<string> {
  const proc = await $`git -C ${repo} ${args}`.nothrow().quiet();
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

async function seedRepo(path: string, files: Record<string, string>): Promise<void> {
  await $`git init -q -b main ${path}`.quiet();
  await git(path, "config", "user.email", "test@example.com");
  await git(path, "config", "user.name", "Test");
  await commit(path, "initial", files);
}

async function commit(
  repo: string,
  message: string,
  files: Record<string, string>,
): Promise<string> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(repo, rel, ".."), { recursive: true });
    await writeFile(join(repo, rel), body);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

/** Install every skill a source has — the store's `select` callback, non-interactively. */
const all = async (candidates: string[]) => candidates;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-skills-store-")));
  servantRoot = join(scratch, ".ai_servant");
  claudeHome = join(scratch, ".claude");
  await mkdir(servantRoot, { recursive: true });
  await mkdir(join(claudeHome, "skills"), { recursive: true });

  priorClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  setRootOverride(servantRoot);

  alpha = join(scratch, "alpha-skills");
  await seedRepo(alpha, {
    "skills/tdd/SKILL.md": "---\nname: tdd\n---\nred, green, refactor\n",
    "skills/tdd/reference.md": "notes\n",
    "skills/teach/SKILL.md": "---\nname: teach\n---\nexplain a slice\n",
    "README.md": "alpha\n",
  });

  beta = join(scratch, "beta-skills");
  await seedRepo(beta, { "tdd/SKILL.md": "---\nname: tdd\n---\nbeta's take on tdd\n" });
});

afterAll(async () => {
  setRootOverride(null);
  if (priorClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfigDir;
  await rm(scratch, { recursive: true, force: true });
});

describe("parseSource", () => {
  test("a bare owner/repo slug is GitHub, and namespaces the store", () => {
    expect(parseSource("mattpocock/skills")).toEqual({
      raw: "mattpocock/skills",
      slug: "mattpocock__skills",
      gitUrl: "https://github.com/mattpocock/skills.git",
    });
  });

  test("a URL is handed to git as-is", () => {
    const parsed = parseSource("https://github.com/anthropics/skills.git");
    expect(parsed.gitUrl).toBe("https://github.com/anthropics/skills.git");
    expect(parsed.slug).toBe("anthropics__skills");
  });

  test("a filesystem path keeps its own url and gets a filename-safe slug", () => {
    const parsed = parseSource("/tmp/local/my-skills");
    expect(parsed.gitUrl).toBe("/tmp/local/my-skills");
    expect(parsed.slug).toBe("local__my-skills");
  });
});

describe("skillName", () => {
  test("comes from the directory in the source", () => {
    expect(skillName({ source: "a/b", path: "skills/tdd" })).toBe("tdd");
  });

  test("falls back to the source's own name when the repo is one skill", () => {
    expect(skillName({ source: "mattpocock/grilling", path: "." })).toBe("grilling");
  });
});

describe("hashSkillDir", () => {
  test("is a 12-hex digest, stable across reads and sensitive to content", async () => {
    const dir = join(scratch, "hash-me");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "one\n");
    const first = await hashSkillDir(dir);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(await hashSkillDir(dir)).toBe(first);

    await writeFile(join(dir, "SKILL.md"), "two\n");
    expect(await hashSkillDir(dir)).not.toBe(first);
  });

  test("is sensitive to a rename, not just to bytes", async () => {
    const a = join(scratch, "hash-a");
    const b = join(scratch, "hash-b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "SKILL.md"), "same\n");
    await writeFile(join(b, "OTHER.md"), "same\n");
    expect(await hashSkillDir(a)).not.toBe(await hashSkillDir(b));
  });
});

describe("discoverSkills", () => {
  test("finds nested skill directories", async () => {
    expect(await discoverSkills(alpha)).toEqual(["skills/tdd", "skills/teach"]);
  });

  test("reads a repo that is itself one skill as `.`", async () => {
    const single = join(scratch, "single-skill");
    await mkdir(single, { recursive: true });
    await writeFile(join(single, "SKILL.md"), "---\nname: solo\n---\n");
    expect(await discoverSkills(single)).toEqual(["."]);
  });
});

describe("install", () => {
  test("copies each skill into the store and records source, ref, path and hash", async () => {
    const result = await installFromSource(alpha, all);
    expect(result).not.toBeNull();
    expect(result?.installed.map((i) => i.name).sort()).toEqual(["tdd", "teach"]);

    const slug = parseSource(alpha).slug;
    const tddDir = skillStoreDir(slug, "tdd");
    expect(await readFile(join(tddDir, "SKILL.md"), "utf8")).toContain("red, green, refactor");
    expect(existsSync(join(tddDir, "reference.md"))).toBe(true);

    const manifest = await readManifest();
    expect(manifest.version).toBe(1);
    const tdd = manifest.skills.find((e) => skillName(e) === "tdd");
    expect(tdd).toMatchObject({ source: alpha, path: "skills/tdd", enabled: false });
    expect(tdd?.hash).toBe(await hashSkillDir(tddDir));
    expect(tdd?.ref).toBe(await git(alpha, "rev-parse", "HEAD"));
  });

  test("does not copy the source's git directory into the store", async () => {
    expect(existsSync(join(skillStoreDir(parseSource(alpha).slug, "tdd"), ".git"))).toBe(false);
  });

  test("nothing selected installs nothing", async () => {
    expect(await installFromSource(beta, async () => null)).toBeNull();
    expect((await listSkills()).some((s) => s.source === beta)).toBe(false);
  });

  test("rejects a skill the source does not have, naming what it does", async () => {
    await expect(installFromSource(alpha, async () => ["skills/nope"])).rejects.toThrow(
      /has no skill skills\/nope[\s\S]*Available: tdd, teach/,
    );
  });
});

describe("enable and disable", () => {
  test("enabling copies the store directory under the servant- prefix", async () => {
    const { skill, swappedOut } = await enableSkill("tdd");
    expect(swappedOut).toBeUndefined();

    const copy = enabledSkillDir("tdd");
    expect(copy).toBe(join(claudeHome, "skills", `${ENABLED_SKILL_PREFIX}tdd`));
    expect(await readFile(join(copy, "SKILL.md"), "utf8")).toContain("red, green, refactor");
    // The copy is byte-identical to the store, which is what makes the recorded hash true of both.
    expect(await hashSkillDir(copy)).toBe(skill.hash);

    const listed = (await listSkills()).find((s) => s.name === "tdd");
    expect(listed?.enabled).toBe(true);
  });

  test("disabling deletes the copy and keeps the store entry", async () => {
    await disableSkill("tdd");
    expect(existsSync(enabledSkillDir("tdd"))).toBe(false);
    expect(existsSync(skillStoreDir(parseSource(alpha).slug, "tdd"))).toBe(true);

    const listed = (await listSkills()).find((s) => s.name === "tdd");
    expect(listed?.enabled).toBe(false);
  });

  test("a skill that is not installed is named, not guessed at", async () => {
    await expect(enableSkill("no-such-skill")).rejects.toThrow(/is not installed/);
  });

  test("never touches a skill servant did not install", async () => {
    const handmade = join(userClaudeSkillsDir(), "hand-installed");
    await mkdir(handmade, { recursive: true });
    await writeFile(join(handmade, "SKILL.md"), "the user's own\n");

    await enableSkill("tdd");
    await disableSkill("tdd");
    await enableSkill("teach");
    await disableSkill("teach");

    expect(await readFile(join(handmade, "SKILL.md"), "utf8")).toBe("the user's own\n");
  });
});

describe("collision between sources", () => {
  test("a second source's same-named skill installs alongside, marked contested", async () => {
    await installFromSource(beta, all);
    const contested = (await listSkills()).filter((s) => s.name === "tdd");
    expect(contested).toHaveLength(2);
    expect(contested.every((s) => s.contested)).toBe(true);
    expect(contested.map((s) => s.hash)).not.toEqual([
      contested[0]?.hash ?? "",
      contested[0]?.hash ?? "",
    ]);
  });

  test("a bare name is refused while two sources ship it", async () => {
    await expect(enableSkill("tdd")).rejects.toThrow(/more than one source/);
  });

  test("enabling one swaps the other out, and the copy is the winner's bytes", async () => {
    await enableSkill(`${alpha}/tdd`);
    const { swappedOut } = await enableSkill(`${beta}/tdd`);
    expect(swappedOut?.source).toBe(alpha);

    expect(await readFile(join(enabledSkillDir("tdd"), "SKILL.md"), "utf8")).toContain(
      "beta's take",
    );
    const enabled = (await listSkills()).filter((s) => s.name === "tdd" && s.enabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.source).toBe(beta);

    await disableSkill(`${beta}/tdd`);
  });
});

describe("check", () => {
  test("an unmoved source reports current without fetching anything", async () => {
    const results = await checkForUpdates();
    expect(results.length).toBe(3);
    expect(results.every((r) => r.status === "current")).toBe(true);
  });

  test("a moved source that did not change a skill advances its verified ref", async () => {
    const head = await commit(alpha, "touch teach only", {
      "skills/teach/SKILL.md": "---\nname: teach\n---\nexplain a slice, better\n",
    });
    const results = await checkForUpdates();

    const tdd = results.find((r) => r.name === "tdd" && r.source === alpha);
    expect(tdd?.status).toBe("current");
    const entry = (await readManifest()).skills.find(
      (e) => e.source === alpha && skillName(e) === "tdd",
    );
    expect(entry?.ref).toBe(head);

    const teach = results.find((r) => r.name === "teach");
    expect(teach?.status).toBe("outdated");
    expect(teach?.upstreamHash).toMatch(/^[0-9a-f]{12}$/);
  });

  test("detects the change without applying it", async () => {
    const store = skillStoreDir(parseSource(alpha).slug, "teach");
    expect(await readFile(join(store, "SKILL.md"), "utf8")).toBe(
      "---\nname: teach\n---\nexplain a slice\n",
    );
  });

  test("reinstalling is how the new version is reached, and refreshes an enabled copy", async () => {
    await enableSkill(`${alpha}/teach`);
    const result = await installFromSource(alpha, async (c) =>
      c.filter((p) => p.endsWith("teach")),
    );
    const outcome = result?.installed[0];
    expect(outcome?.previousHash).toBeDefined();
    expect(outcome?.hash).not.toBe(outcome?.previousHash);
    expect(outcome?.refreshedEnabled).toBe(true);
    expect(await readFile(join(enabledSkillDir("teach"), "SKILL.md"), "utf8")).toContain(
      "a slice, better",
    );
    expect((await checkForUpdates()).find((r) => r.name === "teach")?.status).toBe("current");
  });

  test("an unreachable source is reported as unreachable, not as current", async () => {
    const manifest = await readManifest();
    const orphan = join(scratch, "deleted-source");
    manifest.skills.push({
      source: orphan,
      ref: "0".repeat(40),
      path: "solo",
      hash: "x",
      enabled: false,
    });
    await Bun.write(skillsManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);

    const results = await checkForUpdates();
    expect(results.find((r) => r.source === orphan)?.status).toBe("unreachable");
  });
});
