import { describe, expect, test } from "bun:test";
import type { ChangeEntry } from "../src/core/insights/changes.ts";
import { buildDashboardData, renderDashboard } from "../src/core/insights/dashboard.ts";
import { buildDigest } from "../src/core/insights/digest.ts";
import type { JudgmentRecord } from "../src/core/insights/judgments.ts";
import type { KnowledgeHealth } from "../src/core/insights/knowledge-health.ts";
import type { SessionMetrics } from "../src/core/insights/metrics.ts";

const NOW = Date.parse("2026-06-18T00:00:00Z");

const emptyHealth: KnowledgeHealth = {
  totalNotes: 0,
  byScope: { topic: 0, project: 0 },
  byRepo: [],
  confidence: { high: 0, medium: 0, low: 0 },
  confidenceUsage: {
    high: { used: 0, dead: 0 },
    medium: { used: 0, dead: 0 },
    low: { used: 0, dead: 0 },
  },
  stale: [],
  rotted: [],
  orphanTags: [],
  dead: [],
};

function rec(
  over: Partial<SessionMetrics> & { sessionId: string; mtimeMs: number },
): SessionMetrics {
  return {
    schema: 6,
    sessionId: over.sessionId,
    workspace: over.workspace ?? "ws",
    repos: [],
    version: "2.1.0",
    setupFingerprint: over.setupFingerprint ?? "aaaaaa000000",
    mtimeMs: over.mtimeMs,
    userTurns: 1,
    assistantTurns: 1,
    tokens: {
      peakContext: 0,
      finalContext: 0,
      contextWindowSize: 200_000,
      totalOutput: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRatio: 0,
      compactionEvents: 0,
      toolBuckets: [],
      topToolResults: [],
      contextCurve: [],
      instructionFootprintTokens: 0,
      ...over.tokens,
    },
    instructions: {
      slashCommands: [],
      ruleViolations: [],
      errorToolResults: 0,
      permissionDenials: 0,
      errorSamples: [],
      userCorrections: 0,
      correctionSamples: [],
      repeatedReads: [],
      ...over.instructions,
    },
    knowledge: {
      recallInvocations: 0,
      knowledgeReads: [],
      recallSurfacedNotes: [],
      recallFollowedByRead: 0,
      recallsConsumed: 0,
      ...over.knowledge,
    },
    candidates: over.candidates ?? [],
  };
}

function digestOf(records: SessionMetrics[], changes: ChangeEntry[], health = emptyHealth) {
  return buildDigest({
    records,
    changes,
    knowledgeHealth: health,
    now: NOW,
    windowLabel: "last 30d",
    workspaceLabel: "all workspaces",
  });
}

/** Pull the JSON the renderer injected into the dashboard's data slot. */
function extractSlot(html: string): unknown {
  const m = html.match(/<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m || m[1] === undefined) throw new Error("data slot not found");
  return JSON.parse(m[1]);
}

describe("buildDashboardData", () => {
  test("maps digest + records + judgments + ledger without inventing metrics", () => {
    const records = [
      rec({
        sessionId: "sess-one",
        mtimeMs: Date.parse("2026-06-10T00:00:00Z"),
        setupFingerprint: "aaaaaa000000",
        tokens: {
          peakContext: 120_000,
          finalContext: 90_000,
          contextWindowSize: 200_000,
          totalOutput: 5000,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheHitRatio: 0.5,
          compactionEvents: 0,
          toolBuckets: [{ tool: "Read", count: 3, chars: 8000, approxTokens: 2000 }],
          topToolResults: [],
          contextCurve: [
            {
              turn: 1,
              context: 10_000,
              output: 100,
              delta: 10_000,
              drivers: [],
              anchor: { turnUuid: null, toolUseId: null, line: 1 },
            },
            {
              turn: 2,
              context: 120_000,
              output: 100,
              delta: 110_000,
              drivers: [{ tool: "Read", approxTokens: 2000 }],
              anchor: { turnUuid: null, toolUseId: null, line: 2 },
            },
          ],
          instructionFootprintTokens: 4000,
        },
        instructions: {
          slashCommands: [],
          ruleViolations: [{ rule: "no-plans-in-repo", detail: "x" }],
          errorToolResults: 2,
          permissionDenials: 1,
          errorSamples: [
            { tool: "Bash: git", snippet: "fatal: not a git repo", permission: false },
          ],
          userCorrections: 1,
          correctionSamples: ["no, use the workspace plans dir"],
          repeatedReads: [],
        },
        knowledge: {
          recallInvocations: 3,
          knowledgeReads: ["/k/a.md"],
          recallSurfacedNotes: ["/k/b.md", "/k/a.md"],
          recallFollowedByRead: 1,
          recallsConsumed: 2,
        },
      }),
      rec({
        sessionId: "sess-two",
        mtimeMs: Date.parse("2026-06-14T00:00:00Z"),
        setupFingerprint: "bbbbbb000000",
        tokens: {
          peakContext: 60_000,
          finalContext: 50_000,
          contextWindowSize: 200_000,
          totalOutput: 1000,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheHitRatio: 0.9,
          compactionEvents: 0,
          toolBuckets: [{ tool: "Read", count: 1, chars: 4000, approxTokens: 1000 }],
          topToolResults: [],
          contextCurve: [],
          instructionFootprintTokens: 4000,
        },
        knowledge: {
          recallInvocations: 1,
          knowledgeReads: ["/k/a.md"],
          recallSurfacedNotes: [],
          recallFollowedByRead: 0,
          recallsConsumed: 0,
        },
      }),
    ];
    const changes: ChangeEntry[] = [
      { ts: Date.parse("2026-06-12T00:00:00Z"), kind: "overlay", id: "general", note: "tuned" },
    ];
    const digest = digestOf(records, changes);
    const judgments: JudgmentRecord[] = [
      {
        schema: 1,
        sessionId: "sess-one",
        judgments: [
          {
            anchor: { turnUuid: "u1", toolUseId: null, line: 2 },
            kind: "context-jump",
            verdict: "wasteful",
            reasoning: "r",
            tokens: 110_000,
          },
          {
            anchor: { turnUuid: "u2", toolUseId: null, line: 3 },
            kind: "large-tool-result",
            verdict: "justified",
            reasoning: "r",
            tokens: 2000,
          },
        ],
      },
    ];

    const d = buildDashboardData({ digest, records, judgments, changes });

    // meta
    expect(d.meta.sessionCount).toBe(2);
    expect(d.meta.fingerprintCount).toBe(2);

    // tuning: two groups oldest→newest, one transition with the attributed change
    expect(d.tuning.groups.map((g) => g.fp6)).toEqual(["aaaaaa", "bbbbbb"]);
    expect(d.tuning.transitions).toHaveLength(1);
    expect(d.tuning.transitions[0]?.changes.map((c) => c.id)).toEqual(["general"]);
    expect(d.tuning.ledger.map((c) => c.id)).toEqual(["general"]);

    // tuning: Tier-2 verdict tally
    expect(d.tuning.judgments.hasJudgments).toBe(true);
    expect(d.tuning.judgments.total).toBe(2);
    expect(d.tuning.judgments.byVerdict.wasteful).toBe(1);
    expect(d.tuning.judgments.byVerdict.justified).toBe(1);

    // context: tool spend merged across groups, sessions ordered by mtime
    expect(d.context.toolSpend[0]).toEqual({ tool: "Read", approxTokens: 3000, count: 4 });
    expect(d.context.sessions.map((s) => s.id8)).toEqual(["sess-one", "sess-two"]);
    expect(d.context.sessions[0]?.curve).toEqual([10_000, 120_000]);
    expect(d.context.sessions[0]?.jumps[0]).toEqual({ turn: 1, delta: 10_000, driver: null });

    // friction: window-wide totals summed from the groups
    expect(d.friction.totals).toEqual({
      errors: 2,
      ruleViolations: 1,
      permissionDenials: 1,
      corrections: 1,
    });
    expect(d.friction.series).toHaveLength(2);

    // friction details: the concrete samples are carried through from the records
    expect(d.friction.details.ruleViolations).toEqual([{ rule: "no-plans-in-repo", detail: "x" }]);
    expect(d.friction.details.errors).toEqual([
      { tool: "Bash: git", snippet: "fatal: not a git repo", permission: false },
    ]);
    expect(d.friction.details.corrections).toEqual(["no, use the workspace plans dir"]);

    // knowledge: recall surfaced/consumed + union of distinct notes used (a.md, b.md = 2)
    expect(d.knowledge.recall).toEqual({ invocations: 4, consumed: 2, distinctNotesUsed: 2 });
  });
});

describe("renderDashboard", () => {
  const base = () => {
    const records = [
      rec({
        sessionId: "abcdef12-3456",
        mtimeMs: NOW,
        tokens: {
          peakContext: 50_000,
          finalContext: 40_000,
          contextWindowSize: 200_000,
          totalOutput: 100,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheHitRatio: 0.7,
          compactionEvents: 0,
          toolBuckets: [{ tool: "Read", count: 1, chars: 4000, approxTokens: 1000 }],
          topToolResults: [],
          contextCurve: [
            {
              turn: 1,
              context: 50_000,
              output: 100,
              delta: 50_000,
              drivers: [],
              anchor: { turnUuid: null, toolUseId: null, line: 1 },
            },
          ],
          instructionFootprintTokens: 4000,
        },
      }),
    ];
    return { records, changes: [] as ChangeEntry[], digest: digestOf(records, []) };
  };

  test("renders the four story sections and is valid (parseable) in its data slot", () => {
    const { records, digest, changes } = base();
    const html = renderDashboard({ digest, records, judgments: [], changes });

    // The four story sections are present in the shipped template (titles built at render time).
    expect(html).toContain("Did my tuning help?");
    expect(html).toContain("Where's context leaking?");
    expect(html).toContain("Friction");
    expect(html).toContain("Knowledge health");

    // the injected payload is well-formed JSON
    const slot = extractSlot(html) as { meta: { sessionCount: number } };
    expect(slot.meta.sessionCount).toBe(1);
  });

  test("is fully self-contained / offline — no CDN or network resources", () => {
    const { records, digest, changes } = base();
    const html = renderDashboard({ digest, records, judgments: [], changes });

    // No external resource tags at all.
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toContain("@import");
    // No runtime network APIs.
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("XMLHttpRequest");
    expect(html).not.toContain("WebSocket");
    // The only permitted absolute URI is the SVG/XML namespace (a URI, never fetched).
    const stripped = html.replaceAll("http://www.w3.org/2000/svg", "");
    expect(stripped).not.toContain("http://");
    expect(stripped).not.toContain("https://");
  });

  test("renders with Tier-1 data only — judgments show an empty placeholder", () => {
    const { records, digest, changes } = base();
    const html = renderDashboard({ digest, records, judgments: [], changes });
    expect(html).toContain("Tier-2 judgment verdicts");
    const slot = extractSlot(html) as { tuning: { judgments: { hasJudgments: boolean } } };
    expect(slot.tuning.judgments.hasJudgments).toBe(false);
  });

  test("enriches the judgments slot when judgment records are present", () => {
    const { records, digest, changes } = base();
    const judgments: JudgmentRecord[] = [
      {
        schema: 1,
        sessionId: "abcdef12-3456",
        judgments: [
          {
            anchor: { turnUuid: "u", toolUseId: null, line: 1 },
            kind: "context-jump",
            verdict: "justified",
            reasoning: "ok",
            tokens: 50_000,
          },
        ],
      },
    ];
    const html = renderDashboard({ digest, records, judgments, changes });
    const slot = extractSlot(html) as {
      tuning: { judgments: { hasJudgments: boolean; total: number } };
    };
    expect(slot.tuning.judgments.hasJudgments).toBe(true);
    expect(slot.tuning.judgments.total).toBe(1);
  });

  test("renders an empty-state with zero sessions", () => {
    const digest = digestOf([], []);
    const html = renderDashboard({ digest, records: [], judgments: [], changes: [] });
    const slot = extractSlot(html) as { meta: { sessionCount: number } };
    expect(slot.meta.sessionCount).toBe(0);
    expect(html.length).toBeGreaterThan(0);
  });

  test("escapes a literal </script> in the data so the slot can't be broken out of", () => {
    const records = [rec({ sessionId: "s", mtimeMs: NOW })];
    const changes: ChangeEntry[] = [
      { ts: NOW, kind: "overlay", id: "evil</script><script>alert(1)</script>" },
    ];
    const digest = digestOf(records, changes);
    const html = renderDashboard({ digest, records, judgments: [], changes });

    // The raw closing tag must be neutralized inside the JSON slot...
    expect(html).toContain("<\\/script>");
    // ...and the parsed payload still round-trips the original string intact.
    const slot = extractSlot(html) as { tuning: { ledger: { id: string }[] } };
    expect(slot.tuning.ledger[0]?.id).toBe("evil</script><script>alert(1)</script>");
  });
});
