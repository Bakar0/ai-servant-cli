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
import { enabledSkillDir, setRootOverride } from "../src/core/paths.ts";

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

/** Run the `skills` command group the way the CLI does, capturing what it printed. */
async function run(...rawArgs: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await runCommand(skillsCommand, { rawArgs: [...rawArgs, "--root", servantRoot] });
  } finally {
    console.log = original;
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
  lastCheck: { status: string } | null;
};

const listJson = async (): Promise<ListedSkill[]> => JSON.parse(await run("list", "--json"));

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

describe("an empty store", () => {
  test("says so, and says how to fill it", async () => {
    expect(await run("list")).toContain("no skills installed");
    expect(await run("check")).toContain("servant skills install");
  });
});

describe("servant skills catalog", () => {
  test("reads the source without installing anything", async () => {
    const out = await run("catalog", source);
    expect(out).toContain("2 skill(s)");
    expect(out).toContain("Test-driven development.");
    expect(out).toContain("[mentions: tdd]");
    expect(out).toContain(`servant skills install ${source} --skill <name>`);
    expect(await listJson()).toEqual([]);
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

    const listed = await listJson();
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
  test("prints the state | source | name | score | update? columns", async () => {
    const out = await run("list");
    const [header, ...rows] = out.split("\n");
    expect(header).toMatch(/STATE\s+SOURCE\s+NAME\s+SCORE\s+UPDATE\?/);
    expect(rows.find((r) => r.includes("tdd"))).toMatch(/^on\s/);
    expect(rows.find((r) => r.includes("teach"))).toMatch(/^off\s/);
    // Listing never touches the network, so update state reads as unchecked until `check` runs.
    expect(rows.every((r) => r.includes("unchecked"))).toBe(true);
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
    expect((await listJson()).every((s) => s.lastCheck?.status === "current")).toBe(true);
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
