import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJudgeDrain, runJudgeFromHook } from "../src/commands/insights-judge.ts";
import { encodeProjectDir, listWorkspaceSessions } from "../src/core/claude-session.ts";
import { registerHeadlessSession } from "../src/core/headless-sessions.ts";
import {
  acquireJudgeLock,
  judgeQueueDepth,
  readJudgeJobs,
  readJudgeStatus,
  releaseJudgeLock,
} from "../src/core/insights/judge-queue.ts";
import {
  JUDGMENTS_SCHEMA_VERSION,
  type Judgment,
  type UnitJudgment,
  anchorKey,
  buildJudgePrompt,
  mergeJudgments,
  mergeUnitJudgments,
  parseJudgments,
  parseUnitJudgments,
  selectCandidatesToJudge,
  selectUnitsToJudge,
} from "../src/core/insights/judgments.ts";
import type { InstructionUnit } from "../src/core/insights/instruction-units.ts";
import type { Candidate } from "../src/core/insights/metrics.ts";
import { readJudgment } from "../src/core/insights/store.ts";
import { insightsJudgmentsDir, setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
let wsCwd: string;
let projectsRoot: string;

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/**
 * A transcript fixture that produces several candidates (a big read + a big context jump) and has
 * enough entries to clear the SessionEnd enqueue floor (MIN_ENTRIES).
 */
function fixtureRecords(): unknown[] {
  const bigRead = "x".repeat(12000); // ~3000 approx tokens → large-tool-result + context-jump driver
  return [
    {
      type: "user",
      uuid: "u0",
      cwd: wsCwd,
      version: "2.1.0",
      message: { role: "user", content: "go" },
    },
    {
      type: "assistant",
      uuid: "a1",
      cwd: wsCwd,
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 20,
        },
        content: [
          { type: "text", text: "reading" },
          {
            type: "tool_use",
            id: "tu-big",
            name: "Read",
            input: { file_path: join(wsCwd, "big.ts") },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "u1",
      cwd: wsCwd,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-big", content: bigRead }],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      cwd: wsCwd,
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 12000,
          cache_creation_input_tokens: 0,
          output_tokens: 30,
        },
        content: [{ type: "text", text: "more" }],
      },
    },
    { type: "user", uuid: "u2", cwd: wsCwd, message: { role: "user", content: "keep going" } },
    {
      type: "assistant",
      uuid: "a3",
      cwd: wsCwd,
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 12100,
          cache_creation_input_tokens: 0,
          output_tokens: 15,
        },
        content: [{ type: "text", text: "done" }],
      },
    },
  ];
}

/** Write the fixture into the correctly-encoded projects dir so listWorkspaceSessions finds it. */
async function writeSessionTranscript(sessionId: string, records: unknown[]): Promise<string> {
  const dir = join(projectsRoot, encodeProjectDir(wsCwd));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

/** Build a deterministic candidate (token-bearing by default so tokens carry through). */
function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    kind: "large-tool-result",
    anchor: { turnUuid: "a1", toolUseId: "tu-big", line: 3 },
    magnitude: 3000,
    summary: "Read result ~3000 tok",
    ...over,
  };
}

/** A deterministic instruction unit (a resident skill by default). */
function unit(over: Partial<InstructionUnit> = {}): InstructionUnit {
  return {
    id: "servant-lead",
    kind: "skill",
    approxTokens: 60,
    resident: true,
    fromStart: true,
    uses: 0,
    ...over,
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-judge-"));
  setRootOverride(tmpRoot);
  // Point the session lister at our own throwaway projects dir.
  projectsRoot = join(tmpRoot, "projects");
  process.env.CLAUDE_PROJECTS_ROOT = projectsRoot;
  wsCwd = join(tmpRoot, "workspaces", "ws");
  await mkdir(wsCwd, { recursive: true });
  process.env.SERVANT_INSIGHTS = "";
  process.env.SERVANT_EXTRACTION = "";
});

afterEach(async () => {
  setRootOverride(null);
  process.env.CLAUDE_PROJECTS_ROOT = "";
  process.env.SERVANT_INSIGHTS = "";
  process.env.SERVANT_EXTRACTION = "";
  await rm(tmpRoot, { recursive: true, force: true });
});

function hookPayload(over: Record<string, unknown> = {}, transcript = ""): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: transcript,
    cwd: wsCwd,
    reason: "clear",
    ...over,
  });
}

describe("pure helpers", () => {
  test("selectCandidatesToJudge: takes fresh candidates up to the remaining cap", () => {
    const cands = [
      candidate({ anchor: { turnUuid: "a1", toolUseId: "t1", line: 1 } }),
      candidate({ anchor: { turnUuid: "a2", toolUseId: "t2", line: 2 } }),
      candidate({ anchor: { turnUuid: "a3", toolUseId: "t3", line: 3 } }),
    ];
    const already: Judgment[] = [
      {
        anchor: cands[0]!.anchor,
        kind: "large-tool-result",
        verdict: "justified",
        reasoning: "",
        tokens: 1,
      },
    ];
    const pick = selectCandidatesToJudge(cands, already, 2);
    // cap 2, 1 already judged → 1 slot; the first not-yet-judged candidate is chosen.
    expect(pick).toHaveLength(1);
    expect(anchorKey(pick[0]!.anchor)).toBe("a2|t2|2");
  });

  test("selectCandidatesToJudge: nothing fresh → empty (the no-op case)", () => {
    const c = candidate();
    const already: Judgment[] = [
      { anchor: c.anchor, kind: c.kind, verdict: "justified", reasoning: "", tokens: c.magnitude },
    ];
    expect(selectCandidatesToJudge([c], already, 8)).toHaveLength(0);
  });

  test("mergeJudgments dedups by anchor", () => {
    const c = candidate();
    const j: Judgment = {
      anchor: c.anchor,
      kind: c.kind,
      verdict: "wasteful",
      reasoning: "x",
      tokens: 1,
    };
    expect(mergeJudgments([j], [j])).toHaveLength(1);
  });

  test("parseJudgments: tolerant of prose/fences, joins by index, coerces invalid verdicts", () => {
    const cands = [
      candidate({ kind: "large-tool-result" }),
      candidate({
        kind: "skill-or-command",
        anchor: { turnUuid: "a2", toolUseId: null, line: 4 },
        magnitude: 1,
      }),
    ];
    const raw =
      'Here you go:\n```json\n[{"index":0,"verdict":"wasteful","reasoning":"too big"},{"index":1,"verdict":"bogus","reasoning":"x"}]\n```';
    const out = parseJudgments(raw, cands);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      anchor: cands[0]!.anchor,
      kind: "large-tool-result",
      verdict: "wasteful",
      reasoning: "too big",
      tokens: 3000,
    });
    // invalid verdict for a skill-or-command coerces to "neutral"; count-kind tokens are 0.
    expect(out[1]?.verdict).toBe("neutral");
    expect(out[1]?.tokens).toBe(0);
  });

  test("parseJudgments still reads the object form the units prompt asks for", () => {
    const cands = [candidate()];
    const raw =
      '{"candidates":[{"index":0,"verdict":"justified","reasoning":"worth it"}],"units":[]}';
    expect(parseJudgments(raw, cands)[0]?.verdict).toBe("justified");
  });

  test("selectUnitsToJudge: costliest-first, skips judged, honors the lever filter and cap", () => {
    const units = [
      unit({ id: "ws:CLAUDE.md", kind: "doc", approxTokens: 2500 }),
      unit({ id: "servant-lead", approxTokens: 60 }),
      unit({ id: "someone-elses-skill", approxTokens: 50 }),
    ];
    const already: UnitJudgment[] = [
      { id: "ws:CLAUDE.md", kind: "doc", invoked: false, verdict: "justified", why: "" },
    ];
    const pick = selectUnitsToJudge(units, already, 3, {
      isJudgeable: (u) => u.kind === "doc" || u.id === "servant-lead",
    });
    // the doc is already judged; the unmanaged skill has no lever behind it.
    expect(pick.map((u) => u.id)).toEqual(["servant-lead"]);
    // cap already spent by prior verdicts → nothing more this run.
    const judgedNow: UnitJudgment[] = pick.map((u) => ({
      id: u.id,
      kind: u.kind,
      invoked: false,
      verdict: "neutral",
      why: "",
    }));
    expect(selectUnitsToJudge(units, [...already, ...judgedNow], 2)).toHaveLength(0);
  });

  test("selectUnitsToJudge: a unit no session has judged yet outranks a bigger, well-covered one", () => {
    const units = [
      unit({ id: "code-review", approxTokens: 114 }),
      unit({ id: "servant-recall", approxTokens: 65 }),
      unit({ id: "unslop", approxTokens: 15 }),
    ];
    // `code-review` has been judged in every session so far; the small ones never got a slot.
    const priorVerdicts = new Map([["code-review", 27]]);
    const pick = selectUnitsToJudge(units, [], 2, { priorVerdicts });
    expect(pick.map((u) => u.id)).toEqual(["servant-recall", "unslop"]);
  });

  test("selectUnitsToJudge: within the same coverage, the costliest unit still goes first", () => {
    const units = [unit({ id: "small", approxTokens: 15 }), unit({ id: "big", approxTokens: 900 })];
    const pick = selectUnitsToJudge(units, [], 1, {
      priorVerdicts: new Map([
        ["small", 1],
        ["big", 1],
      ]),
    });
    expect(pick.map((u) => u.id)).toEqual(["big"]);
  });

  test("mergeUnitJudgments dedups by unit id", () => {
    const u: UnitJudgment = {
      id: "servant-lead",
      kind: "skill",
      invoked: true,
      verdict: "justified",
      why: "x",
    };
    expect(mergeUnitJudgments([u], [u, { ...u, id: "ws:GOAL.md", kind: "doc" }])).toHaveLength(2);
  });

  test("parseUnitJudgments takes only the verdict from the agent — id, kind and invoked are ours", () => {
    const units = [unit({ uses: 2 }), unit({ id: "ws:GOAL.md", kind: "doc", uses: 0 })];
    const raw =
      'done:\n{"candidates":[],"units":[{"index":0,"verdict":"justified","why":"drove the work"},{"index":1,"verdict":"bogus","why":"?"}]}';
    const out = parseUnitJudgments(raw, units);
    expect(out[0]).toEqual({
      id: "servant-lead",
      kind: "skill",
      invoked: true,
      verdict: "justified",
      why: "drove the work",
    });
    // an unknown verdict coerces to neutral; a doc with no reads is not "invoked".
    expect(out[1]?.verdict).toBe("neutral");
    expect(out[1]?.invoked).toBe(false);
  });

  test("parseUnitJudgments: a bare array is read as candidates, so units stay empty", () => {
    const raw = '[{"index":0,"verdict":"justified","reasoning":"x"}]';
    expect(parseUnitJudgments(raw, [unit()])).toHaveLength(0);
  });

  test("buildJudgePrompt states the cost, the use count and the not-invoked-is-not-waste rule", () => {
    const prompt = buildJudgePrompt({
      transcriptPath: "/t.jsonl",
      candidates: [candidate()],
      units: [
        unit({ id: "servant-lead", uses: 0 }),
        unit({ id: "ws:docs/agents/issue-tracker.md", kind: "doc", resident: false, uses: 1 }),
      ],
      outPath: "/out.json",
    });
    expect(prompt).toContain("[u0] skill servant-lead — ~60 tok resident every turn, invoked 0×");
    expect(prompt).toContain("ws:docs/agents/issue-tracker.md — ~60 tok, only if read, read 1×");
    expect(prompt).toContain("never invoked");
    expect(prompt).toContain("can still be **justified**");
  });
});

describe("runJudgeFromHook guards", () => {
  test("enqueues a valid servant session", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    const jobs = await readJudgeJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.session_id).toBe(SESSION_ID);
  });

  test("SERVANT_INSIGHTS set → no enqueue (the judge's own session)", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    process.env.SERVANT_INSIGHTS = "1";
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    expect(await judgeQueueDepth()).toBe(0);
  });

  test("SERVANT_EXTRACTION set → no enqueue (the extraction's own session)", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    process.env.SERVANT_EXTRACTION = "1";
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    expect(await judgeQueueDepth()).toBe(0);
  });

  test("cwd outside workspaces root → no enqueue", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    await runJudgeFromHook(hookPayload({ cwd: "/tmp/elsewhere" }, transcript), { kick: false });
    expect(await judgeQueueDepth()).toBe(0);
  });

  test("malformed payload → no throw, no enqueue", async () => {
    await runJudgeFromHook("not json", { kick: false });
    expect(await judgeQueueDepth()).toBe(0);
  });
});

describe("runJudgeDrain", () => {
  test("produces a judgment record covering the session's candidates (verdict, reasoning, tokens)", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });

    const result = await runJudgeDrain({
      runner: async ({ candidates }) => ({
        sessionId: "headless-1",
        units: [],
        judgments: candidates.map((c) => ({
          anchor: c.anchor,
          kind: c.kind,
          verdict: "justified" as const,
          reasoning: "ok",
          tokens: c.kind === "large-tool-result" || c.kind === "context-jump" ? c.magnitude : 0,
        })),
      }),
    });
    expect(result.skipped).toBe(false);
    expect(result.processed).toBe(1);

    const rec = await readJudgment(SESSION_ID);
    expect(rec?.sessionId).toBe(SESSION_ID);
    expect(rec?.schema).toBe(JUDGMENTS_SCHEMA_VERSION);
    expect(rec && rec.judgments.length).toBeGreaterThan(0);
    for (const j of rec!.judgments) {
      expect(["justified", "wasteful", "neutral", "efficient", "inefficient"]).toContain(j.verdict);
      expect(typeof j.reasoning).toBe("string");
      expect(typeof j.tokens).toBe("number");
      expect(j.anchor).toBeDefined();
    }
    // a real candidate anchor (the big read at line 3) is judged.
    expect(rec!.judgments.some((j) => j.anchor.line === 3)).toBe(true);
  });

  test("judges the instruction units the session ran with, alongside the moments", async () => {
    // The transcript records its own starting skill set; the workspace doc is enumerated from disk.
    const records = [
      {
        type: "attachment",
        cwd: wsCwd,
        attachment: {
          type: "skill_listing",
          isInitial: true,
          names: ["servant-lead", "someone-elses-skill"],
          content:
            "- servant-lead: Report where the whole initiative stands.\n- someone-elses-skill: Something servant never installed.",
        },
      },
      ...fixtureRecords(),
    ];
    await writeFile(join(tmpRoot, "CLAUDE.md"), "# servant conventions\n".repeat(20));
    const transcript = await writeSessionTranscript(SESSION_ID, records);
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });

    let seen: InstructionUnit[] = [];
    await runJudgeDrain({
      runner: async ({ units }) => {
        seen = units;
        return {
          sessionId: "h",
          judgments: [],
          units: units.map((u) => ({
            id: u.id,
            kind: u.kind,
            invoked: u.uses > 0,
            verdict: "justified" as const,
            why: "reasonable to have loaded",
          })),
        };
      },
    });

    // The root conventions doc and the managed skill are judged; the skill servant never installed
    // is in the inventory but has no lever, so it is not.
    expect(seen.map((u) => u.id)).toContain("root:CLAUDE.md");
    expect(seen.map((u) => u.id)).toContain("servant-lead");
    expect(seen.map((u) => u.id)).not.toContain("someone-elses-skill");

    const rec = await readJudgment(SESSION_ID);
    expect(rec?.units.map((u) => u.id)).toContain("servant-lead");
    expect(rec?.units.find((u) => u.id === "root:CLAUDE.md")?.kind).toBe("doc");
  });

  test("units are judged at most once per session (the axis is idempotent too)", async () => {
    const records = [
      {
        type: "attachment",
        cwd: wsCwd,
        attachment: {
          type: "skill_listing",
          isInitial: true,
          names: ["servant-lead"],
          content: "- servant-lead: Report where the whole initiative stands.",
        },
      },
      ...fixtureRecords(),
    ];
    const transcript = await writeSessionTranscript(SESSION_ID, records);
    const runner = async ({
      candidates,
      units,
    }: { candidates: Candidate[]; units: InstructionUnit[] }) => ({
      sessionId: "h",
      judgments: candidates.map((c) => ({
        anchor: c.anchor,
        kind: c.kind,
        verdict: "neutral" as const,
        reasoning: "",
        tokens: 0,
      })),
      units: units.map((u) => ({
        id: u.id,
        kind: u.kind,
        invoked: false,
        verdict: "neutral" as const,
        why: "",
      })),
    });

    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    await runJudgeDrain({ runner });
    const before = await readJudgment(SESSION_ID);
    expect(before?.units.length).toBeGreaterThan(0);

    let secondCalls = 0;
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    const second = await runJudgeDrain({
      runner: async (input) => {
        secondCalls += 1;
        return runner(input);
      },
    });

    expect(second.processed).toBe(0); // nothing left to judge on either axis
    expect(secondCalls).toBe(0);
    expect((await readJudgment(SESSION_ID))?.units).toEqual(before?.units);
  });

  test("idempotent: a second drain with no new candidates is a no-op", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    const runner = async ({ candidates }: { candidates: Candidate[] }) => ({
      sessionId: "h",
      units: [],
      judgments: candidates.map((c) => ({
        anchor: c.anchor,
        kind: c.kind,
        verdict: "neutral" as const,
        reasoning: "",
        tokens: 0,
      })),
    });

    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    const first = await runJudgeDrain({ runner });
    const before = await readJudgment(SESSION_ID);

    let secondRunnerCalls = 0;
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    const second = await runJudgeDrain({
      runner: async (input) => {
        secondRunnerCalls += 1;
        return runner(input);
      },
    });
    const after = await readJudgment(SESSION_ID);

    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0); // nothing new to judge
    expect(secondRunnerCalls).toBe(0); // runner never invoked
    expect(after?.judgments).toEqual(before?.judgments); // record unchanged
  });

  test("caps the number of candidates judged per session", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    let received = 0;
    await runJudgeDrain({
      maxCandidates: 1,
      runner: async ({ candidates }) => {
        received = candidates.length;
        return {
          sessionId: "h",
          units: [],
          judgments: candidates.map((c) => ({
            anchor: c.anchor,
            kind: c.kind,
            verdict: "neutral" as const,
            reasoning: "",
            tokens: 0,
          })),
        };
      },
    });
    expect(received).toBe(1);
    const rec = await readJudgment(SESSION_ID);
    expect(rec?.judgments).toHaveLength(1);
  });

  test("is a no-op when the lock is held (serialization)", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    expect(await acquireJudgeLock()).toBe(true);
    try {
      const result = await runJudgeDrain({
        runner: async () => ({ sessionId: "h", judgments: [], units: [] }),
      });
      expect(result.skipped).toBe(true);
      expect(await judgeQueueDepth()).toBe(1); // untouched
    } finally {
      await releaseJudgeLock();
    }
  });

  test("records a runner error in the drain status without throwing", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    await runJudgeDrain({
      runner: async () => {
        throw new Error("judge blew up");
      },
    });
    const status = await readJudgeStatus();
    expect(status?.error).toContain("judge blew up");
    expect(status?.processed).toBe(0);
  });
});

describe("self-measurement exclusion", () => {
  test("a registered headless session is excluded from the session listing", async () => {
    // A normal user session and a servant headless session, both under the workspace.
    await writeSessionTranscript(SESSION_ID, fixtureRecords());
    const headlessId = "ffffffff-1111-2222-3333-444444444444";
    await writeSessionTranscript(headlessId, fixtureRecords());

    const beforeIds = (await listWorkspaceSessions({ workspaceName: "ws" })).map(
      (s) => s.sessionId,
    );
    expect(beforeIds).toContain(SESSION_ID);
    expect(beforeIds).toContain(headlessId);

    await registerHeadlessSession(headlessId);

    const afterIds = (await listWorkspaceSessions({ workspaceName: "ws" })).map((s) => s.sessionId);
    expect(afterIds).toContain(SESSION_ID); // the real session still measured
    expect(afterIds).not.toContain(headlessId); // the servant's own run is not
  });

  test("the judgment store area is created via the insights-store lifecycle", async () => {
    const transcript = await writeSessionTranscript(SESSION_ID, fixtureRecords());
    await runJudgeFromHook(hookPayload({}, transcript), { kick: false });
    await runJudgeDrain({
      runner: async ({ candidates }) => ({
        sessionId: "h",
        units: [],
        judgments: candidates.map((c) => ({
          anchor: c.anchor,
          kind: c.kind,
          verdict: "neutral" as const,
          reasoning: "",
          tokens: 0,
        })),
      }),
    });
    // the record landed under insights/judgments/<sessionId>.json
    const body = await readFile(join(insightsJudgmentsDir(), `${SESSION_ID}.json`), "utf8");
    expect(JSON.parse(body).sessionId).toBe(SESSION_ID);
  });
});
