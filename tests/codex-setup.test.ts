import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexPromptBodies,
  sweepRetiredCodexPrompts,
  toCodexPrompt,
  withOwnershipMarker,
} from "../src/core/codex-setup.ts";

/** The ownership marker itself, taken from the one function that writes it. */
const MARKER = withOwnershipMarker("").trim();

/** Run `body` against a throwaway CODEX_HOME, restoring the env afterwards. */
async function withCodexHome(body: (promptsDir: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "servant-codex-home-"));
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await mkdir(join(home, "prompts"), { recursive: true });
    await body(join(home, "prompts"));
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

describe("toCodexPrompt", () => {
  test("renames the servant slash-command namespace from `:` to `-`", () => {
    expect(toCodexPrompt("run /servant:goal then /servant:delegate")).toBe(
      "run /servant-goal then /servant-delegate",
    );
  });

  test("repoints the Claude transcript root at the Codex session store", () => {
    expect(toCodexPrompt("read ~/.claude/projects/**/x.jsonl")).toBe(
      "read ~/.codex/sessions/**/x.jsonl",
    );
  });

  test("leaves unrelated content untouched", () => {
    const body = "# Heading\n\n`$ARGUMENTS` is the query. Run `servant recall`.";
    expect(toCodexPrompt(body)).toBe(body);
  });
});

describe("ensureCodexAssets", () => {
  test("installs every servant prompt into CODEX_HOME/prompts, transformed", async () => {
    await withCodexHome(async (prompts) => {
      const { ensureCodexAssets } = await import("../src/core/codex-setup.ts");
      await ensureCodexAssets();
      const files = (await readdir(prompts)).toSorted();
      expect(files).toEqual([
        "servant-delegate.md",
        "servant-extract-memories.md",
        "servant-fine-tune.md",
        "servant-goal.md",
        "servant-lead.md",
        "servant-recall.md",
        "servant-skills.md",
      ]);
      // Every one of these is a core skill. Codex has no skills mechanism, so its prompts have to
      // come from the skill templates — the same strings, from the other location — or
      // `/servant-goal` and friends would simply vanish from Codex with no error.
      const goal = await readFile(join(prompts, "servant-goal.md"), "utf8");
      expect(goal).toContain("name: servant-goal");
      expect(goal).toContain("/servant-goal");
      expect(goal).not.toContain("/servant:goal");

      const delegate = await readFile(join(prompts, "servant-delegate.md"), "utf8");
      expect(delegate).toContain("/servant-delegate");
    });
  });

  test("stamps every prompt it writes as servant's, so a later sweep can prove ownership", async () => {
    await withCodexHome(async (prompts) => {
      const { ensureCodexAssets } = await import("../src/core/codex-setup.ts");
      await ensureCodexAssets();
      for (const name of await readdir(prompts)) {
        const body = await readFile(join(prompts, name), "utf8");
        expect(body.split(MARKER)).toHaveLength(2);
        expect(body.trimEnd().endsWith(MARKER)).toBe(true);
      }
    });
  });

  test("sweeps the prompt of a unit servant no longer ships, on the next sync", async () => {
    await withCodexHome(async (prompts) => {
      const { ensureCodexAssets } = await import("../src/core/codex-setup.ts");
      // `servant-handoff.md` sits on every install that predates servant-skill-rework#8, written
      // by a servant that predates the ownership marker, so it carries none. Renaming the unit to
      // `delegate` is what orphans it, and this list entry is what lets the sweep reach it.
      const retiredPreMarker = join(prompts, "servant-handoff.md");
      await writeFile(retiredPreMarker, "---\ndescription: the old handoff command\n---\n");
      // A unit retired *after* markers exist is recognized by its marker alone — no list involved.
      const retiredMarked = join(prompts, "servant-somethingelse.md");
      await writeFile(retiredMarked, withOwnershipMarker("# /servant-somethingelse\n"));

      await ensureCodexAssets();

      expect(existsSync(retiredPreMarker)).toBe(false);
      expect(existsSync(retiredMarked)).toBe(false);
      // The units servant still ships are untouched by the sweep.
      expect(existsSync(join(prompts, "servant-goal.md"))).toBe(true);
    });
  });

  test("leaves the user's own prompts alone, including one that borrows servant's name", async () => {
    await withCodexHome(async (prompts) => {
      const { ensureCodexAssets } = await import("../src/core/codex-setup.ts");
      const theirs = join(prompts, "my-own-prompt.md");
      // The dangerous case: a hand-written file whose name looks exactly like one of servant's.
      // Ownership is the marker, not the name, so this survives.
      const theirsNamedLikeOurs = join(prompts, "servant-my-own-thing.md");
      await writeFile(theirs, "# my own prompt\n");
      await writeFile(theirsNamedLikeOurs, "# also mine\n");

      await ensureCodexAssets();

      expect(await readFile(theirs, "utf8")).toBe("# my own prompt\n");
      expect(await readFile(theirsNamedLikeOurs, "utf8")).toBe("# also mine\n");
    });
  });
});

describe("sweepRetiredCodexPrompts", () => {
  test("reports nothing when the prompts directory does not exist", async () => {
    expect(
      await sweepRetiredCodexPrompts(join(tmpdir(), "servant-no-such-dir-xyz"), new Set()),
    ).toEqual([]);
  });

  test("keeps a marked prompt whose id is still shipped", async () => {
    await withCodexHome(async (prompts) => {
      const kept = join(prompts, "servant-goal.md");
      await writeFile(kept, withOwnershipMarker("# /servant-goal\n"));
      expect(await sweepRetiredCodexPrompts(prompts, new Set(["servant-goal.md"]))).toEqual([]);
      expect(existsSync(kept)).toBe(true);
    });
  });
});

describe("codexPromptBodies", () => {
  test("serves every core skill, and nothing else — servant ships no slash commands", () => {
    const bodies = codexPromptBodies();
    expect([...bodies.keys()].toSorted()).toEqual([
      "delegate",
      "extract-memories",
      "fine-tune",
      "goal",
      "lead",
      "recall",
      "skills",
    ]);
    expect(bodies.get("recall")).toContain("name: servant-recall");
    expect(bodies.get("delegate")).toContain("name: servant-delegate");
    // The id never carries the directory's `servant-` prefix, or the filename would double it.
    expect([...bodies.keys()].some((k) => k.startsWith("servant-"))).toBe(false);
  });
});

describe("withOwnershipMarker", () => {
  test("survives the `/servant:` rewrite — the marker is stamped after the transform, never before", () => {
    const stamped = withOwnershipMarker(toCodexPrompt("# /servant:goal\n"));
    expect(toCodexPrompt(stamped)).toBe(stamped);
  });
});
