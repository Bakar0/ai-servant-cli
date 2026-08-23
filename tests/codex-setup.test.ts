import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPromptBodies, toCodexPrompt } from "../src/core/codex-setup.ts";

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
    const home = await mkdtemp(join(tmpdir(), "servant-codex-home-"));
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const { ensureCodexAssets } = await import("../src/core/codex-setup.ts");
      await ensureCodexAssets();
      const files = (await readdir(join(home, "prompts"))).toSorted();
      expect(files).toEqual([
        "servant-extract-memories.md",
        "servant-fine-tune.md",
        "servant-goal.md",
        "servant-handoff.md",
        "servant-lead.md",
        "servant-recall.md",
      ]);
      // Every one of these but `handoff` is a core skill now. Codex has no skills mechanism, so
      // its prompts have to come from the skill templates — the same strings, from the other
      // location — or `/servant-goal` and friends would simply vanish from Codex with no error.
      const goal = await readFile(join(home, "prompts", "servant-goal.md"), "utf8");
      expect(goal).toContain("name: servant-goal");
      expect(goal).toContain("/servant-goal");
      expect(goal).not.toContain("/servant:goal");

      const handoff = await readFile(join(home, "prompts", "servant-handoff.md"), "utf8");
      expect(handoff).toContain("/servant-handoff");
      expect(handoff).not.toContain("/servant:handoff");
    } finally {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("codexPromptBodies", () => {
  test("a core skill replaces the command of the same id, so a half-converted set has no gap", () => {
    const bodies = codexPromptBodies();
    // Converted: served from the skill.
    expect(bodies.get("recall")).toContain("name: servant-recall");
    expect(bodies.get("goal")).toContain("name: servant-goal");
    // Not yet converted: still served from the command it remains (#8 converts it).
    expect(bodies.get("handoff")).toContain("disable-model-invocation: true");
    // The id never carries the directory's `servant-` prefix, or the filename would double it.
    expect([...bodies.keys()].some((k) => k.startsWith("servant-"))).toBe(false);
  });
});
