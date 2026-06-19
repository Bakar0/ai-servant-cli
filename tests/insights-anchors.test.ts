import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CandidateKind, extractSessionMetrics } from "../src/core/insights/metrics.ts";
import { getOrComputeMetrics } from "../src/core/insights/store.ts";
import { insightsMetricsDir, setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
let workspace: string;
let worktree: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-insights-anchors-"));
  setRootOverride(tmpRoot);
  workspace = join(tmpRoot, "workspaces", "ws-alpha");
  worktree = join(workspace, "repos", "api-gw__main");
  await mkdir(worktree, { recursive: true });
});

afterEach(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

async function writeFixture(records: unknown[]): Promise<string> {
  const dir = join(tmpRoot, "projects", "enc");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SESSION_ID}.jsonl`);
  await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

/** A transcript that exercises every candidate kind, with stable uuids on every record. */
function allKindsRecords(): { records: unknown[]; bigReadPath: string; dupPath: string } {
  const bigReadPath = join(worktree, "src", "huge.ts");
  const dupPath = join(worktree, "src", "config.ts");
  const planPath = join(worktree, "docs", "plans", "scratch.md"); // in-repo plan → rule violation
  const bigRead = "x".repeat(8000); // ~2000 approx tokens
  const records = [
    // line 1 — launch + version carrier
    {
      type: "user",
      uuid: "u-launch",
      cwd: worktree,
      version: "2.1.99",
      message: { role: "user", content: "go" },
    },
    // line 2 — assistant turn A: small context, issues a big Read, a duplicate Read, and an
    // in-repo Write (the rule violation).
    {
      type: "assistant",
      uuid: "a1",
      cwd: worktree,
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 500,
          output_tokens: 200,
        },
        content: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "tu-big", name: "Read", input: { file_path: bigReadPath } },
          { type: "tool_use", id: "tu-dup-1", name: "Read", input: { file_path: dupPath } },
          { type: "tool_use", id: "tu-write", name: "Write", input: { file_path: planPath } },
        ],
      },
    },
    // line 3 — tool results for turn A (the big Read lands here)
    {
      type: "user",
      uuid: "u-res-a",
      cwd: worktree,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-big", content: bigRead },
          { type: "tool_result", tool_use_id: "tu-dup-1", content: "small" },
          { type: "tool_result", tool_use_id: "tu-write", content: "ok" },
        ],
      },
    },
    // line 4 — a slash-command turn (skill-or-command)
    {
      type: "user",
      uuid: "u-cmd",
      cwd: worktree,
      message: { role: "user", content: "<command-name>/servant:recall</command-name> auth" },
    },
    // line 5 — assistant turn B: a big context jump, a Skill invocation, and the second read of
    // the duplicate path.
    {
      type: "assistant",
      uuid: "a2",
      cwd: worktree,
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 0,
          output_tokens: 50,
        },
        content: [
          { type: "text", text: "more" },
          { type: "tool_use", id: "tu-dup-2", name: "Read", input: { file_path: dupPath } },
          { type: "tool_use", id: "tu-skill", name: "Skill", input: { skill: "servant:delegate" } },
        ],
      },
    },
    // line 6 — tool results for turn B
    {
      type: "user",
      uuid: "u-res-b",
      cwd: worktree,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-dup-2", content: "small" },
          { type: "tool_result", tool_use_id: "tu-skill", content: "done" },
        ],
      },
    },
    // line 7 — a user correction right after an assistant action
    {
      type: "user",
      uuid: "u-fix",
      cwd: worktree,
      message: { role: "user", content: "no, that's wrong — revert it" },
    },
  ];
  return { records, bigReadPath, dupPath };
}

describe("transcript anchors", () => {
  test("moment-bearing metrics carry anchors that resolve to real turns / tool results", async () => {
    const { records } = allKindsRecords();
    const m = await extractSessionMetrics(await writeFixture(records));

    // context-curve points anchor to the assistant turn that produced the usage.
    expect(m.tokens.contextCurve).toHaveLength(2);
    expect(m.tokens.contextCurve[0]?.anchor).toEqual({
      turnUuid: "a1",
      toolUseId: null,
      line: 2,
    });
    expect(m.tokens.contextCurve[1]?.anchor).toEqual({
      turnUuid: "a2",
      toolUseId: null,
      line: 5,
    });

    // the largest tool result anchors to the issuing turn (a1), its tool_use_id, and the line of
    // the tool_result record (line 3).
    const big = m.tokens.topToolResults[0];
    expect(big?.tool).toBe("Read");
    expect(big?.anchor).toEqual({ turnUuid: "a1", toolUseId: "tu-big", line: 3 });
  });

  test("anchors and candidates are identical across recomputes of the same transcript", async () => {
    const { records } = allKindsRecords();
    const path = await writeFixture(records);
    const a = await extractSessionMetrics(path);
    const b = await extractSessionMetrics(path);
    expect(b.candidates).toEqual(a.candidates);
    expect(b.tokens.contextCurve).toEqual(a.tokens.contextCurve);
    expect(b.tokens.topToolResults).toEqual(a.tokens.topToolResults);
  });
});

describe("candidate flagging", () => {
  test("flags all six kinds, each anchored", async () => {
    const { records } = allKindsRecords();
    const m = await extractSessionMetrics(await writeFixture(records));

    const kinds = new Set<CandidateKind>(m.candidates.map((c) => c.kind));
    for (const kind of [
      "large-tool-result",
      "context-jump",
      "skill-or-command",
      "repeated-read",
      "user-correction",
      "rule-violation",
    ] as CandidateKind[]) {
      expect(kinds).toContain(kind);
    }

    // every candidate carries an anchor with at least a line, and most a turn uuid.
    for (const c of m.candidates) {
      expect(c.anchor).toBeDefined();
      expect(typeof c.summary).toBe("string");
      expect(c.summary.length).toBeGreaterThan(0);
    }

    // sanity-check a couple of specific anchors.
    const jump = m.candidates.find((c) => c.kind === "context-jump");
    expect(jump?.anchor.turnUuid).toBe("a2");
    expect(jump?.magnitude).toBe(8500); // 10010 - 1510

    const viol = m.candidates.find((c) => c.kind === "rule-violation");
    expect(viol?.anchor).toEqual({ turnUuid: "a1", toolUseId: "tu-write", line: 2 });

    const repeat = m.candidates.find((c) => c.kind === "repeated-read");
    expect(repeat?.magnitude).toBe(2);
    expect(repeat?.anchor).toEqual({ turnUuid: "a1", toolUseId: "tu-dup-1", line: 2 });
  });

  test("candidates are ordered largest-magnitude first and bounded by the cap", async () => {
    const { records } = allKindsRecords();
    const path = await writeFixture(records);

    const full = await extractSessionMetrics(path);
    const mags = full.candidates.map((c) => c.magnitude);
    expect(mags).toEqual([...mags].toSorted((x, y) => y - x)); // non-increasing

    const capped = await extractSessionMetrics(path, { maxCandidates: 3 });
    expect(capped.candidates).toHaveLength(3);
    // The three largest magnitudes: context-jump (8500), large-tool-result (2000), repeated-read (2).
    expect(capped.candidates.map((c) => c.kind)).toEqual([
      "context-jump",
      "large-tool-result",
      "repeated-read",
    ]);
  });
});

describe("metrics cache invalidation", () => {
  test("a schema-stale cached record is recomputed; a current one is reused", async () => {
    const { records } = allKindsRecords();
    const path = await writeFixture(records);
    const { mtimeMs } = await stat(path);

    await mkdir(insightsMetricsDir(), { recursive: true });
    const cachePath = join(insightsMetricsDir(), `${SESSION_ID}.json`);

    // Seed a stale (old-schema) cache record with a sentinel — it must NOT be reused.
    await writeFile(
      cachePath,
      JSON.stringify({ schema: 3, sessionId: SESSION_ID, mtimeMs, userTurns: 999 }),
    );
    const recomputed = await getOrComputeMetrics(path, mtimeMs);
    expect(recomputed.userTurns).not.toBe(999); // recomputed from the transcript
    expect(recomputed.candidates.length).toBeGreaterThan(0); // and carries the new fields

    // Seed a current-schema record with a matching mtime — it MUST be reused verbatim.
    await writeFile(cachePath, JSON.stringify({ ...recomputed, userTurns: 777 }));
    const reused = await getOrComputeMetrics(path, mtimeMs);
    expect(reused.userTurns).toBe(777);
  });
});
