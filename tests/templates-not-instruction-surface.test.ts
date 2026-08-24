import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { templateDiskRels } from "../scripts/template-paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "src", "templates");

// Claude Code and Codex discover instructions by *path*, and they do not care that the tree they
// found is a template: a `CLAUDE.md` under `src/templates/` loads as a memory doc, and a
// `.claude/skills/` tree there registers its skills, in any session that happens to work in this
// repo. Measured at ~3,400 resident tokens per session (servant-skill-rework#16), for content that
// is data, not guidance — and duplicating the real root conventions, which such a session has
// already loaded for real.
//
// So the escaped on-disk names are not cosmetic, and this is the invariant that keeps them. It is
// also the only tractable one: the real symptom is an agent's discovery pass, which no test can
// observe. Guard the cause instead, over the whole tree, so the next template shaped this way
// fails here rather than quietly costing every session in the repo.
const AUTO_LOADED_BASENAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];

describe("src/templates/ is not a live instruction surface", () => {
  test("no template is named like a doc an agent auto-loads", async () => {
    const rels = await templateDiskRels(templatesDir);
    const offenders = rels.filter((rel) =>
      AUTO_LOADED_BASENAMES.includes(rel.split("/").at(-1) ?? ""),
    );
    expect(offenders).toEqual([]);
  });

  // `SKILL.md` needs no entry above: a skill is only discovered *inside* a `.claude/skills/` tree,
  // so forbidding the dot-directory is what forbids the phantom skills.
  test("no dot-directory, so no `.claude/` for a skill scanner to find", async () => {
    const rels = await templateDiskRels(templatesDir);
    const offenders = rels.filter((rel) => rel.split("/").some((seg) => seg.startsWith(".")));
    expect(offenders).toEqual([]);
  });
});
