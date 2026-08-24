import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectInstructionUnits,
  normalizeInvocationName,
  parseSkillListing,
  splitGeneratedRegions,
} from "../src/core/insights/instruction-units.ts";
import type { JudgmentRecord } from "../src/core/insights/judgments.ts";
import { extractSessionMetrics, readShapedBashPaths } from "../src/core/insights/metrics.ts";
import {
  UNJUDGEABLE,
  UNSCORED,
  describeUnitScore,
  formatUnitScore,
  rankUnits,
  summarizeUnits,
  unitCoverage,
} from "../src/core/insights/unit-scores.ts";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
let wsDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-units-"));
  setRootOverride(tmpRoot);
  wsDir = join(tmpRoot, "workspaces", "ws-alpha");
  await mkdir(join(wsDir, "docs", "agents"), { recursive: true });
});

afterEach(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** The starting-set attachment Claude Code writes into the transcript. */
function skillListing(over: Record<string, unknown> = {}): unknown {
  return {
    type: "attachment",
    attachment: {
      type: "skill_listing",
      isInitial: true,
      skillCount: 2,
      names: ["servant-lead", "mattpocock-skills:tdd"],
      content:
        "- servant-lead: Report where the whole initiative stands.\n  Use when the user asks how the work is going.\n- mattpocock-skills:tdd: Test-driven development.",
      ...over,
    },
  };
}

describe("parseSkillListing", () => {
  test("attributes each description to its skill, including namespaced and wrapped entries", () => {
    const perName = parseSkillListing(
      "- alpha: one liner\n- plugin:beta: wrapped description\n  continued on the next line\n",
    );
    expect([...perName.keys()]).toEqual(["alpha", "plugin:beta"]);
    // the continuation line is charged to the entry above it, not dropped
    expect(perName.get("plugin:beta")).toBeGreaterThan(perName.get("alpha") ?? 0);
  });
});

describe("normalizeInvocationName", () => {
  test("a slash command and a Skill call are the same unit", () => {
    expect(normalizeInvocationName("/servant-lead")).toBe("servant-lead");
    expect(normalizeInvocationName(" servant-lead ")).toBe("servant-lead");
  });
});

describe("collectInstructionUnits", () => {
  test("skills come from the transcript, top-level docs from disk, uses from what fired", async () => {
    await writeFile(join(tmpRoot, "CLAUDE.md"), "x".repeat(4000)); // servant's root conventions
    await writeFile(join(wsDir, "CLAUDE.md"), "y".repeat(2000));
    await writeFile(join(wsDir, "GOAL.md"), "z".repeat(400));
    await writeFile(join(wsDir, "CONTEXT.md"), "c".repeat(800));
    await writeFile(join(wsDir, "docs", "agents", "issue-tracker.md"), "t".repeat(1200));

    const units = await collectInstructionUnits({
      records: [skillListing() as { attachment?: unknown }],
      invocations: ["/servant-lead", "servant-lead", "tdd"],
      readCounts: new Map([[join(wsDir, "docs", "agents", "issue-tracker.md"), 2]]),
      workspace: "ws-alpha",
    });
    const byId = new Map(units.map((u) => [u.id, u]));

    // largest cost first — the root conventions doc, which no session ever "invokes".
    expect(units[0]?.id).toBe("root:CLAUDE.md");
    expect(byId.get("root:CLAUDE.md")).toMatchObject({ kind: "doc", resident: true, uses: 0 });
    expect(byId.get("ws:CLAUDE.md")?.approxTokens).toBe(500);

    // a slash command and a Skill call land on the same unit; a bare name resolves the namespaced one.
    expect(byId.get("servant-lead")?.uses).toBe(2);
    expect(byId.get("mattpocock-skills:tdd")?.uses).toBe(1);
    expect(byId.get("servant-lead")).toMatchObject({ resident: true, fromStart: true });

    // the board contract costs nothing until read, and reading it is its use signal.
    expect(byId.get("ws:docs/agents/issue-tracker.md")).toMatchObject({
      kind: "doc",
      resident: false,
      uses: 2,
    });
    expect(byId.get("ws:CONTEXT.md")?.resident).toBe(false);
  });

  test("a skill added mid-session is not in the starting set", async () => {
    const units = await collectInstructionUnits({
      records: [
        skillListing({ names: ["servant-lead"], content: "- servant-lead: a." }) as {
          attachment?: unknown;
        },
        skillListing({
          isInitial: false,
          names: ["late-arrival"],
          content: "- late-arrival: b.",
        }) as { attachment?: unknown },
      ],
      invocations: [],
      readCounts: new Map(),
      workspace: null,
    });
    const byId = new Map(units.map((u) => [u.id, u]));
    expect(byId.get("servant-lead")?.fromStart).toBe(true);
    expect(byId.get("late-arrival")?.fromStart).toBe(false);
    // Disabling mid-session never retracts a description, so both still cost the session.
    expect(byId.get("late-arrival")?.resident).toBe(true);
  });

  test("only the rendering the session's backend loads counts as a doc unit", async () => {
    await writeFile(join(wsDir, "CLAUDE.md"), "claude");
    await writeFile(join(wsDir, "AGENTS.md"), "codex");
    await mkdir(join(wsDir, ".servant"), { recursive: true });
    await writeFile(join(wsDir, ".servant", "agent"), "codex\n");

    const ids = (
      await collectInstructionUnits({
        records: [],
        invocations: [],
        readCounts: new Map(),
        workspace: "ws-alpha",
      })
    ).map((u) => u.id);
    expect(ids).toContain("ws:AGENTS.md");
    expect(ids).not.toContain("ws:CLAUDE.md"); // the other backend's twin was never loaded
  });

  test("the metrics record carries the inventory (schema v7)", async () => {
    await writeFile(join(wsDir, "CLAUDE.md"), "y".repeat(2000));
    const dir = join(tmpRoot, "projects", "enc");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
    await writeFile(
      path,
      `${[
        { type: "user", cwd: wsDir, version: "2.1.0", message: { role: "user", content: "go" } },
        skillListing(),
        {
          type: "assistant",
          cwd: wsDir,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "leading" },
              { type: "tool_use", id: "t1", name: "Skill", input: { skill: "servant-lead" } },
            ],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );

    const rec = await extractSessionMetrics(path, { sessionId: "s1" });
    const lead = rec.instructionUnits.find((u) => u.id === "servant-lead");
    expect(lead?.uses).toBe(1);
    expect(rec.instructionUnits.some((u) => u.id === "ws:CLAUDE.md")).toBe(true);
  });
});

describe("unit scores (aggregated on read)", () => {
  function record(sessionId: string, units: JudgmentRecord["units"]): JudgmentRecord {
    return { schema: 2, sessionId, judgments: [], units };
  }

  test("nets justified against wasteful across sessions and counts actual use", () => {
    const scores = summarizeUnits([
      record("s1", [
        { id: "servant-lead", kind: "skill", invoked: true, verdict: "justified", why: "" },
        { id: "root:CLAUDE.md", kind: "doc", invoked: false, verdict: "wasteful", why: "" },
      ]),
      record("s2", [
        { id: "servant-lead", kind: "skill", invoked: false, verdict: "justified", why: "" },
        { id: "root:CLAUDE.md", kind: "doc", invoked: false, verdict: "neutral", why: "" },
      ]),
    ]);

    expect(scores.get("servant-lead")).toMatchObject({ sessions: 2, invoked: 1, net: 2 });
    expect(scores.get("root:CLAUDE.md")).toMatchObject({ wasteful: 1, neutral: 1, net: -1 });
    expect(formatUnitScore(scores.get("servant-lead"))).toBe("+2/2");
    expect(formatUnitScore(scores.get("root:CLAUDE.md"))).toBe("-1/2");
    expect(formatUnitScore(undefined)).toBe("—");
    expect(describeUnitScore(undefined)).toContain("no session has judged it");
    expect(describeUnitScore(scores.get("servant-lead"))).toContain("2 justified");
    // worst first — the reading order for deciding what to stop loading.
    expect(rankUnits(scores).map((u) => u.id)).toEqual(["root:CLAUDE.md", "servant-lead"]);
  });

  test("a record written before the axis existed contributes nothing rather than throwing", () => {
    const legacy = { schema: 2, sessionId: "old", judgments: [] } as unknown as JudgmentRecord;
    expect(summarizeUnits([legacy]).size).toBe(0);
  });
});

describe("splitGeneratedRegions", () => {
  test("a doc with no generated marker is one authored region", () => {
    expect(splitGeneratedRegions("# hand written\n")).toEqual([{ name: null, chars: 15 }]);
  });

  test("a stamped region splits off from the prose above it and runs to EOF", () => {
    const prose =
      "<!-- servant:conventions v=abc — generated by servant; edits here are overwritten -->\n# prose\n";
    const payload =
      "<!-- servant:knowledge — auto-generated by `servant`; edits below are overwritten -->\npayload\n";
    const regions = splitGeneratedRegions(prose + payload);
    expect(regions).toEqual([
      { name: null, chars: prose.length },
      { name: "knowledge", chars: payload.length },
    ]);
  });

  test("a second region ends the first, and same-named markers merge", () => {
    const a = "authored\n";
    const one = "<!-- servant:knowledge — edits below are overwritten -->\nnotes\n";
    const two = "<!-- servant:other — edits below are overwritten -->\nmore\n";
    const three = "<!-- servant:knowledge — edits below are overwritten -->\ntail\n";
    const regions = splitGeneratedRegions(a + one + two + three);
    expect(regions).toEqual([
      { name: null, chars: a.length },
      { name: "knowledge", chars: one.length + three.length },
      { name: "other", chars: two.length },
    ]);
  });

  test("a whole-file stamp is not a region boundary — it says edits *here*, not below", () => {
    const doc =
      "<!-- servant:agent-doc v=abc — generated by servant; edits here are overwritten -->\nbody\n";
    expect(splitGeneratedRegions(doc)).toEqual([{ name: null, chars: doc.length }]);
  });
});

describe("generated regions as their own units", () => {
  test("a doc's payload is charged to its own unit, not laundered by the prose", async () => {
    const prose = "# conventions\n";
    const payload =
      "<!-- servant:knowledge — auto-generated by `servant`; edits below are overwritten -->\n" +
      `${"n".repeat(4000)}\n`;
    await writeFile(join(wsDir, "CLAUDE.md"), prose + payload);

    const units = await collectInstructionUnits({
      records: [],
      invocations: [],
      readCounts: new Map(),
      workspace: "ws-alpha",
    });
    const byId = new Map(units.map((u) => [u.id, u]));
    const doc = byId.get("ws:CLAUDE.md");
    const region = byId.get("ws:CLAUDE.md#knowledge");
    expect(doc?.approxTokens).toBe(Math.round(prose.length / 4));
    expect(region?.approxTokens).toBe(Math.round(payload.length / 4));
    expect(region?.kind).toBe("doc");
    // the payload sits in context every turn exactly as its parent does
    expect(region?.resident).toBe(true);
  });

  test("reading the file counts as a read of every region inside it", async () => {
    await writeFile(
      join(wsDir, "CLAUDE.md"),
      "# prose\n<!-- servant:knowledge — edits below are overwritten -->\nnotes\n",
    );
    const units = await collectInstructionUnits({
      records: [],
      invocations: [],
      readCounts: new Map([[join(wsDir, "CLAUDE.md"), 2]]),
      workspace: "ws-alpha",
    });
    const byId = new Map(units.map((u) => [u.id, u]));
    expect(byId.get("ws:CLAUDE.md")?.uses).toBe(2);
    expect(byId.get("ws:CLAUDE.md#knowledge")?.uses).toBe(2);
  });

  test("a doc with no generated region gains no sub-unit", async () => {
    await writeFile(join(wsDir, "GOAL.md"), "# goal\n");
    const ids = (
      await collectInstructionUnits({
        records: [],
        invocations: [],
        readCounts: new Map(),
        workspace: "ws-alpha",
      })
    ).map((u) => u.id);
    expect(ids).toContain("ws:GOAL.md");
    expect(ids.filter((id) => id.startsWith("ws:GOAL.md#"))).toEqual([]);
  });
});

describe("readShapedBashPaths", () => {
  test("pulls file operands out of the read-shaped commands docs are actually read with", () => {
    expect(readShapedBashPaths("cat GOAL.md")).toEqual(["GOAL.md"]);
    expect(readShapedBashPaths("sed -n 1,40p /abs/CLAUDE.md")).toContain("/abs/CLAUDE.md");
    expect(readShapedBashPaths("head -20 a.md && cat b.md")).toEqual(["a.md", "b.md"]);
    expect(readShapedBashPaths('grep -n "servant recall" docs/agents/issue-tracker.md')).toContain(
      "docs/agents/issue-tracker.md",
    );
  });

  test("ignores commands that are not reads, and tokens that are not operands", () => {
    expect(readShapedBashPaths("servant recall foo")).toEqual([]);
    expect(readShapedBashPaths("rm -rf GOAL.md")).toEqual([]);
    expect(readShapedBashPaths("git log --oneline")).toEqual([]);
    expect(readShapedBashPaths("cat a.md > out.txt")).toEqual(["a.md"]);
  });
});

describe("doc uses counted through Bash", () => {
  test("a doc read with cat is a use, so the re-read signal can fire at all", async () => {
    await writeFile(join(wsDir, "GOAL.md"), "# goal\n");
    const dir = join(tmpRoot, "projects", "enc");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "22222222-2222-3333-4444-555555555555.jsonl");
    await writeFile(
      path,
      `${[
        { type: "user", cwd: wsDir, message: { role: "user", content: "go" } },
        {
          type: "assistant",
          cwd: wsDir,
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "b1", name: "Bash", input: { command: "cat GOAL.md" } },
            ],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );
    const rec = await extractSessionMetrics(path, { sessionId: "s-bash" });
    expect(rec.instructionUnits.find((u) => u.id === "ws:GOAL.md")?.uses).toBe(1);
    // a Bash read of a doc is not the `Read`-tool repeated-read signal — that list is untouched
    expect(rec.instructions.repeatedReads).toEqual([]);
  });

  test("a knowledge note read with grep counts as knowledge use", async () => {
    const notePath = join(tmpRoot, "knowledge", "notes", "thing.md");
    await mkdir(join(tmpRoot, "knowledge", "notes"), { recursive: true });
    await writeFile(notePath, "note\n");
    const dir = join(tmpRoot, "projects", "enc");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "33333333-2222-3333-4444-555555555555.jsonl");
    await writeFile(
      path,
      `${[
        { type: "user", cwd: wsDir, message: { role: "user", content: "go" } },
        {
          type: "assistant",
          cwd: wsDir,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "b1",
                name: "Bash",
                input: { command: `cat ${notePath}` },
              },
            ],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );
    const rec = await extractSessionMetrics(path, { sessionId: "s-know" });
    expect(rec.knowledge.knowledgeReads).toContain(notePath);
  });
});

describe("unjudgeable units", () => {
  test("a unit no session can ever judge reads differently from one nothing has judged yet", () => {
    expect(formatUnitScore(undefined)).toBe(UNSCORED);
    expect(formatUnitScore(undefined, false)).toBe(UNJUDGEABLE);
    expect(describeUnitScore(undefined, false)).toContain(UNJUDGEABLE);
    expect(describeUnitScore(undefined, false)).not.toBe(describeUnitScore(undefined));
  });

  test("a verdict already on record still wins over the unjudgeable label", () => {
    const scores = summarizeUnits([
      {
        schema: 2,
        sessionId: "s1",
        judgments: [],
        units: [{ id: "implement", kind: "skill", invoked: true, verdict: "justified", why: "" }],
      },
    ]);
    expect(formatUnitScore(scores.get("implement"), false)).toBe("+1/1");
  });
});

describe("unitCoverage", () => {
  test("counts how many sessions have produced a verdict for each unit", () => {
    const rec = (id: string, sessionId: string): JudgmentRecord => ({
      schema: 2,
      sessionId,
      judgments: [],
      units: [{ id, kind: "skill", invoked: false, verdict: "neutral", why: "" }],
    });
    const coverage = unitCoverage([rec("a", "s1"), rec("a", "s2"), rec("b", "s3")]);
    expect(coverage.get("a")).toBe(2);
    expect(coverage.get("b")).toBe(1);
    expect(coverage.get("c")).toBeUndefined();
  });
});
