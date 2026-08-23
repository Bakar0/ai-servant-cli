import { describe, expect, test } from "bun:test";
import { renderAgentSkillsBlock } from "../src/core/skills-config.ts";
import { coreSkillNames } from "../src/core/skills.ts";
import { TEMPLATES } from "../src/templates/index.generated.ts";

// The servant-root conventions doc is the single source both of a workspace's agent-conventions
// docs render (see workspace.ts), so guarding it here guards both renderings. The pointer block is
// the other piece of servant prose that lands in them.
const CONVENTIONS =
  TEMPLATES.find((t) => t.rel === "servant_root/CLAUDE.md")?.content ?? "MISSING TEMPLATE";
const POINTER_BLOCK = renderAgentSkillsBlock("acme");

describe("the conventions prose a workspace session loads", () => {
  test("the bundled template is actually in the manifest", () => {
    expect(CONVENTIONS).not.toBe("MISSING TEMPLATE");
  });

  // servant installs no skill and depends on none. A third-party name here is an instruction only
  // that plugin's user can follow — and every reader of these docs gets it either way.
  test("names no third-party plugin and none of its skills", () => {
    for (const term of [
      "mattpocock",
      "plugin",
      "/grill-me",
      "/to-spec",
      "/to-tickets",
      "/implement",
      "/tdd",
      "/code-review",
      "/wayfinder",
      "/domain-modeling",
      "/teach",
      "/wait-what",
    ]) {
      expect(CONVENTIONS.toLowerCase(), `conventions names ${term}`).not.toContain(term);
      expect(POINTER_BLOCK.toLowerCase(), `pointer block names ${term}`).not.toContain(term);
    }
  });

  // #8 renamed the mechanism and deleted the doc it used to write. Any surviving reference sends a
  // session to a skill that no longer exists, or tells it to write a file that no longer has a job.
  test("no reference to the retired handoff command survives", () => {
    for (const term of ["/servant:handoff", "/handoff", "servant-handoff"]) {
      expect(CONVENTIONS).not.toContain(term);
      expect(POINTER_BLOCK).not.toContain(term);
    }
  });

  // Derived from what actually ships, not a hand-kept list: a core skill added or renamed without
  // the prose following would leave a session unable to find it (or reaching for a ghost).
  test("names every core skill that ships, and no name that does not", () => {
    const named = [...CONVENTIONS.matchAll(/\/(servant-[a-z-]+)/g)].map((m) => m[1] ?? "");
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...new Set(named)].toSorted(byName)).toEqual(coreSkillNames().toSorted(byName));
  });

  test("points at the skills surface for everything that is not core", () => {
    expect(CONVENTIONS).toContain("servant skills list");
    expect(CONVENTIONS).toContain("servant skills [list|…]"); // in the command list
  });

  // #7 made docs/agents the board's public contract; describing it as one skill set's config
  // invites an agent to treat it as optional configuration rather than the interface it is.
  test("describes docs/agents as the board's public contract", () => {
    expect(CONVENTIONS).toContain("public contract");
    expect(POINTER_BLOCK).toContain("public contract");
  });
});
