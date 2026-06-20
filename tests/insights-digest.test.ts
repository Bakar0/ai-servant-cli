import { describe, expect, test } from "bun:test";
import { buildDigest, renderDigest, renderSessionTimeline } from "../src/core/insights/digest.ts";
import type { ChangeEntry } from "../src/core/insights/changes.ts";
import type { KnowledgeHealth } from "../src/core/insights/knowledge-health.ts";
import type { SessionMetrics } from "../src/core/insights/metrics.ts";

const NOW = Date.parse("2026-06-18T00:00:00Z");

const emptyHealth: KnowledgeHealth = {
  totalNotes: 0,
  byScope: { topic: 0, project: 0 },
  byRepo: [],
  confidence: { high: 0, medium: 0, low: 0 },
  stale: [],
  rotted: [],
  orphanTags: [],
  dead: [],
};

function rec(over: {
  fingerprint: string;
  mtimeMs: number;
  peakContext?: number;
  cacheHitRatio?: number;
  ruleViolations?: number;
}): SessionMetrics {
  return {
    schema: 2,
    sessionId: `s-${over.fingerprint}-${over.mtimeMs}`,
    workspace: "ws",
    repos: [],
    version: "2.1.0",
    setupFingerprint: over.fingerprint,
    mtimeMs: over.mtimeMs,
    userTurns: 1,
    assistantTurns: 1,
    tokens: {
      peakContext: over.peakContext ?? 0,
      finalContext: 0,
      contextWindowSize: 200_000,
      totalOutput: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRatio: over.cacheHitRatio ?? 0,
      compactionEvents: 0,
      toolBuckets: [],
      topToolResults: [],
      contextCurve: [],
      instructionFootprintTokens: 0,
    },
    instructions: {
      slashCommands: [],
      ruleViolations: Array.from({ length: over.ruleViolations ?? 0 }, () => ({
        rule: "no-plans-in-repo",
        detail: "x",
      })),
      errorToolResults: 0,
      permissionDenials: 0,
      userCorrections: 0,
      repeatedReads: [],
    },
    knowledge: {
      recallInvocations: 0,
      knowledgeReads: [],
      recallSurfacedNotes: [],
      recallFollowedByRead: 0,
      recallsConsumed: 0,
    },
    candidates: [],
  };
}

describe("buildDigest before/after segmentation", () => {
  test("two fingerprint groups split by a change show a delta and the attributed change", () => {
    const t0 = Date.parse("2026-06-10T00:00:00Z");
    const tChange = Date.parse("2026-06-12T00:00:00Z");
    const t1 = Date.parse("2026-06-14T00:00:00Z");

    const records: SessionMetrics[] = [
      rec({
        fingerprint: "aaaaaa000000",
        mtimeMs: t0,
        peakContext: 100_000,
        cacheHitRatio: 0.5,
        ruleViolations: 2,
      }),
      rec({
        fingerprint: "bbbbbb000000",
        mtimeMs: t1,
        peakContext: 60_000,
        cacheHitRatio: 0.9,
        ruleViolations: 0,
      }),
    ];
    const changes: ChangeEntry[] = [
      { ts: tChange, kind: "overlay", id: "general", note: "General instructions" },
    ];

    const digest = buildDigest({
      records,
      changes,
      knowledgeHealth: emptyHealth,
      now: NOW,
      windowLabel: "last 30d",
      workspaceLabel: "all workspaces",
    });

    // Two groups, ordered oldest → newest.
    expect(digest.groups.map((g) => g.fingerprint)).toEqual(["aaaaaa000000", "bbbbbb000000"]);
    expect(digest.transitions.length).toBe(1);

    const t = digest.transitions[0];
    expect(t?.fromFingerprint).toBe("aaaaaa000000");
    expect(t?.toFingerprint).toBe("bbbbbb000000");
    // The ledger entry between the groups is attributed to the transition.
    expect(t?.changes.map((c) => c.id)).toEqual(["general"]);
    // Deltas reflect the improvement.
    expect(t?.deltas.avgPeakContext).toBe(-40_000);
    expect(t?.deltas.ruleViolations).toBe(-2);
    expect(t?.deltas.avgCacheHitRatio ?? 0).toBeCloseTo(0.4, 5);

    // Render mentions both fingerprints and the change.
    const text = renderDigest(digest);
    expect(text).toContain("aaaaaa → bbbbbb");
    expect(text).toContain("overlay general");
  });

  test("renders an empty-state message when there are no sessions", () => {
    const digest = buildDigest({
      records: [],
      changes: [],
      knowledgeHealth: emptyHealth,
      now: NOW,
      windowLabel: "last 30d",
      workspaceLabel: "all workspaces",
    });
    expect(renderDigest(digest)).toContain("No servant sessions");
  });
});

describe("renderSessionTimeline candidate worklist", () => {
  test("renders the anchored candidate list with kind tags and magnitudes", () => {
    const m = rec({ fingerprint: "cccccc000000", mtimeMs: NOW });
    m.tokens.peakContext = 5000;
    m.tokens.finalContext = 5000;
    m.tokens.contextCurve = [
      {
        turn: 1,
        context: 5000,
        output: 100,
        delta: 5000,
        drivers: [{ tool: "Read", approxTokens: 2000 }],
        anchor: { turnUuid: "a1aaaaaa", toolUseId: null, line: 2 },
      },
    ];
    m.tokens.topToolResults = [
      {
        tool: "Read",
        target: "/x/y.ts",
        chars: 8000,
        approxTokens: 2000,
        anchor: { turnUuid: "a1aaaaaa", toolUseId: "tu-1", line: 3 },
      },
    ];
    m.candidates = [
      {
        kind: "context-jump",
        anchor: { turnUuid: "a1aaaaaa", toolUseId: null, line: 2 },
        magnitude: 5000,
        summary: "turn 1 context +~5000 tok",
      },
      {
        kind: "repeated-read",
        anchor: { turnUuid: "b9bbbbbb", toolUseId: "tu-9", line: 42 },
        magnitude: 3,
        summary: "read /x/y.ts ×3",
      },
    ];

    const text = renderSessionTimeline(m);

    // header + both kinds present
    expect(text).toContain("candidates worth a closer look (2");
    expect(text).toContain("ctx-jump");
    expect(text).toContain("re-read");
    // token kinds read as ~Nk, count kinds as ×N
    expect(text).toContain("~5.0k");
    expect(text).toContain("×3");
    // anchors expose the transcript line (the drill target) and a turn-uuid prefix
    expect(text).toContain("L2");
    expect(text).toContain("@a1aaaaaa");
    expect(text).toContain("L42");
    // the largest-result line is also anchored now
    expect(text).toMatch(/single largest tool results:[\s\S]*L3 +@a1aaaaaa/);
  });
});
