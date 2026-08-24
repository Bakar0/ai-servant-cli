// The `servant skills` CLI surface, driven the way a user drives it: a real git source in a temp
// scratch dir, a real store under a temp servant root, and a real (temp) Claude skills directory.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "citty";
import {
  type SkillPicker,
  type SkillRow,
  browseSkills,
  skillsCommand,
} from "../src/commands/skills.ts";
import { enabledSkillDir, insightsJudgmentsDir, setRootOverride } from "../src/core/paths.ts";

let scratch: string;
let servantRoot: string;
let claudeHome: string;
let source: string;
let priorClaudeConfigDir: string | undefined;

async function git(repo: string, ...args: string[]): Promise<string> {
  const proc = await $`git -C ${repo} ${args}`.nothrow().quiet();
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

/** Run the `skills` command group the way the CLI does, capturing what it printed on stdout. */
async function run(...rawArgs: string[]): Promise<string> {
  return capture(() => runCommand(skillsCommand, { rawArgs: [...rawArgs, "--root", servantRoot] }));
}

/** The same, but capturing stderr — where status notes go so stdout stays parseable. */
async function runStderr(...rawArgs: string[]): Promise<string> {
  return capture(
    () => runCommand(skillsCommand, { rawArgs: [...rawArgs, "--root", servantRoot] }),
    "error",
  );
}

async function capture(
  fn: () => Promise<unknown>,
  stream: "log" | "error" = "log",
): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  const sink = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  const noop = () => undefined;
  console.log = stream === "log" ? sink : noop;
  console.error = stream === "error" ? sink : noop;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
  return lines.join("\n");
}

type ListedSkill = {
  name: string;
  source: string;
  hash: string;
  enabled: boolean;
  contested: boolean;
  drift: string;
  storeDir: string;
  modelInvocable: boolean;
  enabledCopy: string;
  enabledHash: string | null;
  localHash: string | null;
  lastCheck: { status: string } | null;
  score: { sessions: number; justified: number; wasteful: number; net: number } | null;
};

type ListedForeign = {
  name: string;
  invocation: string;
  dir: string;
  origin: { kind: string; id?: string; plugin?: string; scope?: string; dir?: string };
  description: string;
  modelInvocable: boolean;
  approxTokens: number;
};

type ListPayload = {
  skills: ListedSkill[];
  foreign: ListedForeign[];
  collisions: {
    name: string;
    foreignInvocation: string;
    foreignOrigin: { kind: string };
    storeSources: string[];
  }[];
};

const listPayload = async (): Promise<ListPayload> => JSON.parse(await run("list", "--json"));

const listJson = async (): Promise<ListedSkill[]> => (await listPayload()).skills;

const FOREIGN_HEADING = "FOREIGN — reachable by a session, not owned by the store";

/** The store's own table: everything `list` prints before the foreign section starts. */
const storeSection = (out: string): string[] => out.split("\n").slice(0, sectionStart(out));

/** The foreign section, heading included. */
const foreignSection = (out: string): string[] => out.split("\n").slice(sectionStart(out));

function sectionStart(out: string): number {
  const lines = out.split("\n");
  const at = lines.indexOf(FOREIGN_HEADING);
  // The blank line before the heading belongs to neither table.
  return at === -1 ? lines.length : at - 1;
}

// Core skills are in every listing by construction. Assertions about what a *source* put in the
// store filter them out; the core rows have their own describe block.
const installedJson = async (): Promise<ListedSkill[]> =>
  (await listJson()).filter((s) => s.source !== "core");

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-skills-cmd-")));
  servantRoot = join(scratch, ".ai_servant");
  claudeHome = join(scratch, ".claude");
  await mkdir(servantRoot, { recursive: true });
  await mkdir(join(claudeHome, "skills"), { recursive: true });

  priorClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  setRootOverride(servantRoot);

  source = join(scratch, "source-skills");
  await $`git init -q -b main ${source}`.quiet();
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "config", "user.name", "Test");
  await mkdir(join(source, "tdd"), { recursive: true });
  await mkdir(join(source, "teach"), { recursive: true });
  await writeFile(
    join(source, "tdd", "SKILL.md"),
    "---\nname: tdd\ndescription: Test-driven development.\n---\nred, green, refactor\n",
  );
  await writeFile(
    join(source, "teach", "SKILL.md"),
    "---\nname: teach\ndescription: Explain a slice.\n---\nGoes well with /tdd.\n",
  );
  await git(source, "add", "-A");
  await git(source, "commit", "-qm", "initial");
});

afterAll(async () => {
  setRootOverride(null);
  if (priorClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfigDir;
  await rm(scratch, { recursive: true, force: true });
});

describe("the move out of ~/.claude/skills", () => {
  test("sweeps a stale copy the old layout left behind, and says where skills live now", async () => {
    const stale = join(claudeHome, "skills", "servant-leftover");
    const mine = join(claudeHome, "skills", "my-own-skill");
    await mkdir(stale, { recursive: true });
    await mkdir(mine, { recursive: true });
    await writeFile(join(stale, "SKILL.md"), "old location\n");
    await writeFile(join(mine, "SKILL.md"), "the user's own\n");

    const out = await runStderr("list");
    expect(out).toContain("removed the old copy: ~/.claude/skills/servant-leftover");
    expect(out).toContain(join(servantRoot, ".claude", "skills"));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });
});

describe("an empty store", () => {
  test("says so, and says how to fill it — beneath the core skills that are always there", async () => {
    const out = await run("list");
    expect(out).toContain("servant-recall");
    expect(out).toContain("nothing installed");
    expect(await run("check")).toContain("servant skills install");
  });
});

describe("core skills", () => {
  test("are listed as core, always on, and never flippable", async () => {
    const core = (await listJson()).filter((s) => s.source === "core");
    expect(core.map((s) => s.name)).toContain("servant-recall");
    expect(core.every((s) => s.enabled)).toBe(true);
    expect(await run("list")).toMatch(/core\s+core\s+servant-recall/);

    await expect(run("disable", "servant-recall")).rejects.toThrow(/always on/);
    await expect(run("enable", "servant-recall")).rejects.toThrow(/always on/);
  });

  test("are materialized by a listing, so `on` is never a claim about a file that is not there", async () => {
    const dir = join(servantRoot, ".claude", "skills", "servant-recall");
    await rm(dir, { recursive: true, force: true });
    await run("list");
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
  });

  test("reserve their name: a source shipping one cannot install or shadow it", async () => {
    const rival = join(scratch, "rival-skills");
    await $`git init -q -b main ${rival}`.quiet();
    await git(rival, "config", "user.email", "test@example.com");
    await git(rival, "config", "user.name", "Test");
    await mkdir(join(rival, "servant-recall"), { recursive: true });
    await writeFile(
      join(rival, "servant-recall", "SKILL.md"),
      "---\nname: servant-recall\ndescription: An impostor.\n---\nnot ours\n",
    );
    await git(rival, "add", "-A");
    await git(rival, "commit", "-qm", "initial");

    await expect(run("install", rival, "--all")).rejects.toThrow(/core skill/);
    // The refusal happened before anything was written.
    expect((await listJson()).filter((s) => s.source === rival)).toEqual([]);
    expect(
      await readFile(join(servantRoot, ".claude", "skills", "servant-recall", "SKILL.md"), "utf8"),
    ).toContain("servant knowledge base");
  });
});

describe("servant skills catalog", () => {
  test("reads the source without installing anything", async () => {
    const out = await run("catalog", source);
    expect(out).toContain("2 skill(s)");
    expect(out).toContain("Test-driven development.");
    expect(out).toContain("[mentions: tdd]");
    expect(out).toContain(`servant skills install ${source} --skill <name>`);
    expect(await installedJson()).toEqual([]);
  });

  test("--json gives the agent name, path, purpose and siblings", async () => {
    const skills = JSON.parse(await run("catalog", source, "--json"));
    expect(skills).toEqual([
      { name: "tdd", path: "tdd", description: "Test-driven development.", mentions: [] },
      { name: "teach", path: "teach", description: "Explain a slice.", mentions: ["tdd"] },
    ]);
  });
});

describe("servant skills install", () => {
  test("--all installs every skill the source has", async () => {
    const out = await run("install", source, "--all");
    expect(out).toContain("installed tdd");
    expect(out).toContain("installed teach");

    const listed = await installedJson();
    expect(listed.map((s) => s.name)).toEqual(["tdd", "teach"]);
    expect(listed.every((s) => s.source === source)).toBe(true);
    expect(listed.every((s) => /^[0-9a-f]{12}$/.test(s.hash))).toBe(true);
    expect(listed.every((s) => s.enabled)).toBe(false);
  });

  test("--skill installs just the named one, and --enable loads it", async () => {
    await run("disable", "tdd").catch(() => undefined);
    const out = await run("install", source, "--skill", "tdd", "--enable");
    expect(out).toContain("enabled   tdd");
    expect(existsSync(enabledSkillDir("tdd"))).toBe(true);
    expect(existsSync(enabledSkillDir("teach"))).toBe(false);
  });

  test("names what a source actually has when asked for something else", async () => {
    await expect(run("install", source, "--skill", "wizard")).rejects.toThrow(
      /Available: tdd, teach/,
    );
  });
});

describe("servant skills list", () => {
  test("--json stays parseable when a repair happened on the way in", async () => {
    await rm(enabledSkillDir("tdd"), { recursive: true, force: true });
    const parsed = JSON.parse(await run("list", "--json"));
    expect(Array.isArray(parsed.skills)).toBe(true);
    expect(existsSync(enabledSkillDir("tdd"))).toBe(true);
  });

  test("prints the state | source | name | score | update? columns", async () => {
    const [header, ...rows] = storeSection(await run("list"));
    expect(header).toMatch(/STATE\s+SOURCE\s+NAME\s+SCORE\s+UPDATE\?/);
    expect(rows.find((r) => r.includes("tdd"))).toMatch(/^on\s/);
    expect(rows.find((r) => r.includes("teach"))).toMatch(/^off\s/);
    // Listing never touches the network, so update state reads as unchecked until `check` runs.
    expect(rows.every((r) => r.includes("unchecked"))).toBe(true);
  });
});

// The store listing only ever claimed to be the whole account of what a session can invoke. These
// cover the half it never read: enabled plugins and the user's own ~/.claude/skills.
describe("the foreign sources a session can also reach", () => {
  /** Register a plugin the way Claude Code does: an install record plus a cache directory. */
  async function installPlugin(opts: {
    id: string;
    skills: string[];
    enabled?: boolean;
    scope?: string;
  }): Promise<void> {
    const [plugin, marketplace] = opts.id.split("@");
    const installPath = join(
      claudeHome,
      "plugins",
      "cache",
      String(marketplace),
      String(plugin),
      "1.0.0",
    );
    for (const rel of opts.skills) {
      const dir = join(installPath, "skills", rel);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${rel.split("/").pop()}\ndescription: what it is for\n---\nbody\n`,
      );
    }
    await mkdir(join(claudeHome, "plugins"), { recursive: true });
    await writeFile(
      join(claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          [opts.id]: [{ scope: opts.scope ?? "user", installPath, version: "1.0.0" }],
        },
      }),
    );
    await writeFile(
      join(claudeHome, "settings.json"),
      JSON.stringify({ enabledPlugins: { [opts.id]: opts.enabled ?? true } }),
    );
  }

  async function forgetPlugins(): Promise<void> {
    await rm(join(claudeHome, "plugins"), { recursive: true, force: true });
    await rm(join(claudeHome, "settings.json"), { force: true });
  }

  test("lists an enabled plugin's skills under their own section, with the plugin as the origin", async () => {
    await installPlugin({ id: "kit@market", skills: ["engineering/wizard"] });
    try {
      const out = await run("list");
      const foreign = foreignSection(out);
      expect(foreign.join("\n")).toContain("plugin kit@market");
      expect(foreign.find((r) => r.includes("kit:wizard"))).toBeDefined();
      // and it is not smuggled into the store's own rows
      expect(storeSection(out).join("\n")).not.toContain("wizard");
    } finally {
      await forgetPlugins();
    }
  });

  test("calls out a bare-name collision with a store skill instead of merely listing it", async () => {
    await installPlugin({ id: "kit@market", skills: ["engineering/tdd"] });
    try {
      const out = await run("list");
      expect(out).toContain("1 colliding with a store name");
      expect(foreignSection(out).find((r) => r.includes("kit:tdd"))).toContain(source);
      expect(out).toContain("name collision");

      const { collisions } = await listPayload();
      expect(collisions).toEqual([
        {
          name: "tdd",
          foreignInvocation: "kit:tdd",
          foreignOrigin: expect.anything(),
          storeSources: [source],
        },
      ]);
    } finally {
      await forgetPlugins();
    }
  });

  test("a disabled plugin contributes nothing — that is the whole point of reading enabledPlugins", async () => {
    await installPlugin({ id: "kit@market", skills: ["engineering/wizard"], enabled: false });
    try {
      expect((await listPayload()).foreign.map((f) => f.name)).not.toContain("wizard");
    } finally {
      await forgetPlugins();
    }
  });

  test("separates reachable from model-visible so the resident cost is not overstated", async () => {
    await installPlugin({ id: "kit@market", skills: ["engineering/shown", "engineering/hidden"] });
    await writeFile(
      join(
        claudeHome,
        "plugins",
        "cache",
        "market",
        "kit",
        "1.0.0",
        "skills",
        "engineering",
        "hidden",
        "SKILL.md",
      ),
      "---\nname: hidden\ndescription: only by slash\ndisable-model-invocation: true\n---\nbody\n",
    );
    try {
      const out = await run("list");
      expect(out).toMatch(/3 skill\(s\) · 2 model-visible/);
      expect(foreignSection(out).find((r) => r.includes("kit:hidden"))).toMatch(/\sno\s/);
      expect(foreignSection(out).find((r) => r.includes("kit:shown"))).toMatch(/\syes\s/);
      expect((await listPayload()).foreign.find((f) => f.name === "hidden")?.approxTokens).toBe(0);
    } finally {
      await forgetPlugins();
    }
  });

  test("the user's own ~/.claude/skills shows up too, named by its directory", async () => {
    const payload = await listPayload();
    const mine = payload.foreign.find((f) => f.name === "my-own-skill");
    expect(mine?.origin.kind).toBe("personal");
    expect(mine?.invocation).toBe("my-own-skill");
  });
});

describe("the score column", () => {
  /** Write a per-session judgment record carrying unit verdicts, the way the drainer would. */
  async function judgeSession(sessionId: string, verdict: string): Promise<void> {
    await mkdir(insightsJudgmentsDir(), { recursive: true });
    await writeFile(
      join(insightsJudgmentsDir(), `${sessionId}.json`),
      JSON.stringify({
        schema: 2,
        sessionId,
        judgments: [],
        units: [{ id: "tdd", kind: "skill", invoked: true, verdict, why: "drove the work" }],
      }),
    );
  }

  test("reads the session evaluator's unit verdicts, netted over the sessions that judged them", async () => {
    await judgeSession("aaaaaaaa-0000-0000-0000-000000000001", "justified");
    await judgeSession("aaaaaaaa-0000-0000-0000-000000000002", "wasteful");
    await judgeSession("aaaaaaaa-0000-0000-0000-000000000003", "justified");
    try {
      const rows = (await run("list")).split("\n");
      // two justified against one wasteful, over three judged sessions.
      expect(rows.find((r) => r.includes("tdd"))).toMatch(/\s\+1\/3\s/);
      // a skill no session has judged still reads as unscored, not as neutral.
      expect(rows.find((r) => r.includes("teach"))).toMatch(/\s—\s/);
      const scored = (await listJson()).find((s) => s.name === "tdd");
      expect(scored?.score).toMatchObject({ sessions: 3, justified: 2, wasteful: 1, net: 1 });
    } finally {
      await rm(insightsJudgmentsDir(), { recursive: true, force: true });
    }
  });
});

describe("the bare command", () => {
  test("points at `list` when there is no terminal to browse in", async () => {
    // No `--root` here: citty resolves a subcommand as the first non-flag arg, so a flag *value*
    // before the verb reads as the verb. The root is already pinned by setRootOverride.
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await runCommand(skillsCommand, { rawArgs: [] });
    } finally {
      console.log = original;
    }
    expect(lines.join("\n")).toContain("browses interactively");
  });

  test("stands down when a subcommand ran — citty runs a parent's own run() too", async () => {
    expect(await run("list")).not.toContain("browses interactively");
  });
});

describe("servant skills enable / disable", () => {
  test("enable copies the skill under the servant- prefix", async () => {
    const out = await run("enable", "teach");
    expect(out).toContain("enabled teach");
    expect(await readFile(join(enabledSkillDir("teach"), "SKILL.md"), "utf8")).toContain(
      "Goes well with /tdd.",
    );
  });

  // tdd is installed and enabled by this point, so no install is needed to break its copy.
  test("re-materializes an enabled skill whose copy went missing", async () => {
    expect((await listJson()).find((s) => s.name === "tdd")?.enabled).toBe(true);
    await rm(enabledSkillDir("tdd"), { recursive: true, force: true });

    expect(await runStderr("list")).toContain("restored the enabled copy: tdd");
    expect(existsSync(enabledSkillDir("tdd"))).toBe(true);
  });

  test("disable removes the copy and says the skill is still installed", async () => {
    const out = await run("disable", "teach");
    expect(out).toContain("still installed");
    expect(existsSync(enabledSkillDir("teach"))).toBe(false);
    expect((await listJson()).find((s) => s.name === "teach")?.enabled).toBe(false);
  });
});

describe("the browse surface", () => {
  /**
   * Pick the rows naming `wanted` on each round, then close (null) — one entry per round. The
   * browser reopens after every flip, so a picker that never returns null never returns at all.
   */
  function fakePicker(...rounds: string[][]): {
    pick: SkillPicker;
    opened: number;
    seen: { rows: SkillRow[]; headers: string[]; previews: string[] };
  } {
    const seen = { rows: [] as SkillRow[], headers: [] as string[], previews: [] as string[] };
    const state = { opened: 0 };
    const pick: SkillPicker = async (rows, opts) => {
      seen.rows = rows;
      seen.headers.push(opts.header ?? "");
      seen.previews = rows.map((r) => opts.preview?.(r) ?? "");
      const round = rounds[state.opened++];
      return round ? rows.filter((r) => round.includes(r.skill.name)) : null;
    };
    return {
      pick,
      get opened() {
        return state.opened;
      },
      seen,
    };
  }

  async function browse(pick: SkillPicker): Promise<string> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await browseSkills(pick);
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  }

  test("previews a skill's SKILL.md alongside its hash and score", async () => {
    const { pick, seen } = fakePicker();
    await browse(pick);
    const tdd = seen.previews.find((p) => p.startsWith("tdd"));
    expect(tdd).toContain("red, green, refactor");
    expect(tdd).toContain("score:   —");
    expect(tdd).toMatch(/hash:\s+[0-9a-f]{12}/);
  });

  test("picking flips each selected skill's state", async () => {
    const before = await listJson();
    const tddWasEnabled = before.find((s) => s.name === "tdd")?.enabled;
    const teachWasEnabled = before.find((s) => s.name === "teach")?.enabled;
    expect(tddWasEnabled).toBe(true);
    expect(teachWasEnabled).toBe(false);

    const out = await browse(fakePicker(["tdd", "teach"]).pick);
    expect(out).toContain("off  tdd");
    expect(out).toContain("on   teach");

    const after = await listJson();
    expect(after.find((s) => s.name === "tdd")?.enabled).toBe(false);
    expect(after.find((s) => s.name === "teach")?.enabled).toBe(true);
    expect(existsSync(enabledSkillDir("tdd"))).toBe(false);
    expect(existsSync(enabledSkillDir("teach"))).toBe(true);
  });

  test("cancelling changes nothing", async () => {
    const before = await listJson();
    await browse(async () => null);
    expect(await listJson()).toEqual(before);
  });

  test("stays open after a flip, and closes on the key that returns nothing", async () => {
    const picker = fakePicker(["tdd"], ["tdd"]);
    await browse(picker.pick);
    // Two flip rounds plus the round that closed it: the browser reopened rather than exiting.
    expect(picker.opened).toBe(3);
    expect((await listJson()).find((s) => s.name === "tdd")?.enabled).toBe(false);
  });

  test("each reopen shows the state the last flip produced", async () => {
    const seenStates: string[] = [];
    let round = 0;
    await browseSkills(async (rows) => {
      seenStates.push(rows.find((r) => r.skill.name === "tdd")?.label.split(/\s+/)[0] ?? "");
      return round++ < 1 ? rows.filter((r) => r.skill.name === "tdd") : null;
    });
    expect(seenStates).toEqual(["off", "on"]);
  });

  test("says how to leave, and what the columns are", async () => {
    const { pick, seen } = fakePicker();
    await browse(pick);
    expect(seen.headers[0]).toContain("esc closes");
    expect(seen.headers[0]).toContain("STATE");
  });

  // Browsing mutates shared state, so hand the check tests the arrangement they assume — tdd loaded,
  // teach not — instead of relying on how many times the flips above happened to fire.
  test("leaves tdd enabled and teach disabled for what follows", async () => {
    await run("enable", "tdd");
    if ((await listJson()).find((s) => s.name === "teach")?.enabled) await run("disable", "teach");

    const after = await listJson();
    expect(after.find((s) => s.name === "tdd")?.enabled).toBe(true);
    expect(after.find((s) => s.name === "teach")?.enabled).toBe(false);
  });
});

describe("servant skills check", () => {
  test("reports everything current while the source has not moved", async () => {
    expect(await run("check")).toContain("0 outdated");
    expect((await installedJson()).every((s) => s.lastCheck?.status === "current")).toBe(true);
  });

  test("reports the moved skill, and tells the user the reinstall that reaches it", async () => {
    await writeFile(join(source, "tdd", "SKILL.md"), "---\nname: tdd\n---\nred, green, rewrite\n");
    await git(source, "commit", "-aqm", "reword tdd");

    const out = await run("check");
    expect(out).toContain("1 outdated");
    expect(out).toContain(`servant skills install ${source} --skill tdd`);

    // Detected, never applied: the enabled copy still holds the version that was installed.
    expect(await readFile(join(enabledSkillDir("tdd"), "SKILL.md"), "utf8")).toContain(
      "red, green, refactor",
    );
  });

  test("the update column carries the last check's verdict into the listing", async () => {
    const rows = (await run("list")).split("\n");
    expect(rows.find((r) => r.includes("tdd"))).toContain("moved");
    expect(rows.find((r) => r.includes("teach"))).toContain("current");
  });

  test("reinstalling clears the outdated verdict and refreshes the enabled copy", async () => {
    const out = await run("install", source, "--skill", "tdd");
    expect(out).toContain("enabled copy refreshed");
    expect(await readFile(join(enabledSkillDir("tdd"), "SKILL.md"), "utf8")).toContain(
      "red, green, rewrite",
    );
    expect((await listJson()).find((s) => s.name === "tdd")?.lastCheck).toBeNull();
  });
});

describe("local changes at the CLI", () => {
  test("show up in the update column and in check, without a reinstall", async () => {
    const store = (await listJson()).find((s) => s.name === "teach")?.storeDir ?? "";
    await writeFile(join(store, "SKILL.md"), "---\nname: teach\n---\nour own wording\n");

    expect((await run("list")).split("\n").find((r) => r.includes("teach"))).toContain("modified");
    expect(await run("check")).toContain("1 locally changed");
    expect(await run("check")).toContain("modified locally");
  });

  test("block a reinstall until --force, which says what it discards", async () => {
    await expect(run("install", source, "--skill", "teach")).rejects.toThrow(/--force/);
    await run("install", source, "--skill", "teach", "--force");
    expect((await listJson()).find((s) => s.name === "teach")?.drift).toBe("clean");
  });
});

// Drift used to watch the store copy only, so an edit to the copy Claude actually loads was
// invisible to every report and thrown away by the next enable, silently.
describe("the copy Claude loads, when it is not the store's", () => {
  test("shows in the update column, in check, and in what check tells you to run", async () => {
    await run("enable", "teach");
    await writeFile(
      join(enabledSkillDir("teach"), "SKILL.md"),
      "---\nname: teach\n---\nedited where it loads from\n",
    );

    const row = storeSection(await run("list")).find((r) => r.includes("teach"));
    expect(row).toContain("loaded copy edited");

    const checked = await run("check");
    expect(checked).toContain("1 with a loaded copy that is not the store's");
    expect(checked).toContain("loaded copy edited (re-enable to discard it)");
    expect(checked).toContain("servant skills enable teach");

    expect((await listJson()).find((s) => s.name === "teach")?.enabledCopy).toBe("modified");
  });

  test("re-enabling is what clears it, and the store's bytes are what land", async () => {
    await run("enable", "teach");
    const listed = (await listJson()).find((s) => s.name === "teach");
    expect(listed?.enabledCopy).toBe("clean");
    expect(listed?.enabledHash).toBe(listed?.localHash);
    expect(await run("check")).toContain("0 with a loaded copy that is not the store's");
    await run("disable", "teach");
  });
});

describe("a skill Claude Code never lists", () => {
  test("reads as unjudgeable rather than unjudged, because no session can score it", async () => {
    const slashOnly = join(scratch, "slash-only-skills");
    await $`git init -q -b main ${slashOnly}`.quiet();
    await git(slashOnly, "config", "user.email", "test@example.com");
    await git(slashOnly, "config", "user.name", "Test");
    await mkdir(join(slashOnly, "handcrank"), { recursive: true });
    await writeFile(
      join(slashOnly, "handcrank", "SKILL.md"),
      "---\nname: handcrank\ndescription: A human triggers this one.\ndisable-model-invocation: true\n---\nbody\n",
    );
    await git(slashOnly, "add", "-A");
    await git(slashOnly, "commit", "-qm", "initial");

    await run("install", slashOnly, "--skill", "handcrank");
    const rows = (await run("list")).split("\n");
    expect(rows.find((r) => r.includes("handcrank"))).toMatch(/\sn\/a\s/);
    // the model-invocable ones keep the plain unjudged dash
    expect(rows.find((r) => r.includes("teach"))).toMatch(/\s—\s/);

    const json = (await listJson()).find((s) => s.name === "handcrank");
    expect(json?.modelInvocable).toBe(false);
    expect((await listJson()).find((s) => s.name === "teach")?.modelInvocable).toBe(true);
  });
});
