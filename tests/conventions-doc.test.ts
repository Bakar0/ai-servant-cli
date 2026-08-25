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

  // The doc used to enumerate all seven core skills. It stopped (#17): Claude Code already keeps
  // every skill's name *and* description resident in the session's skill listing, so the roster was
  // a second copy of a list the session was handed anyway. The direction that still has a failure
  // mode is the other one — a name here that ships nowhere sends a session after a ghost.
  test("names no servant skill that does not ship", () => {
    const named = [...CONVENTIONS.matchAll(/\/(servant-[a-z-]+)/g)].map((m) => m[1] ?? "");
    const ships = new Set<string>(coreSkillNames());
    expect([...new Set(named)].filter((n) => !ships.has(n))).toEqual([]);
  });

  // #17 again, the larger half: the doc carried the whole delegate procedure — the frontier
  // buckets, the ticket comment, the claim-and-spawn pair — and measurement found sessions running
  // it from the prose by hand (11 hand-written handoffs) while the skill went uninvoked (0). Two
  // copies, and the resident one won. The doc points now; the skill teaches. Every marker below
  // belongs to the procedure, not to a pointer at it.
  test("points at /servant-delegate rather than restating its procedure", () => {
    expect(CONVENTIONS).toContain("/servant-delegate");
    for (const step of [
      "unblocked",
      "in-flight",
      "inFlight",
      "reclaim",
      "ticket comment",
      "--name",
    ]) {
      expect(
        CONVENTIONS,
        `the conventions doc names "${step}" — that is the delegate procedure, and it belongs in the skill`,
      ).not.toContain(step);
    }
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
