import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCodexPrompt } from "../src/core/codex-setup.ts";

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
      const goal = await readFile(join(home, "prompts", "servant-goal.md"), "utf8");
      expect(goal).toContain("/servant-goal");
      expect(goal).not.toContain("/servant:goal");
    } finally {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});
