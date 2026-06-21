import type { ChangeEntry } from "./changes.ts";
import { DASHBOARD_TEMPLATE } from "./dashboard-template.ts";
import type { Digest } from "./digest.ts";
import type { JudgmentRecord, Verdict } from "./judgments.ts";
import type { SessionMetrics } from "./metrics.ts";

// Phase 2a: turn the already-built insights data into a self-contained HTML dashboard. This module
// is the *deterministic renderer* half of ADR-004 — it maps the digest + per-session metrics +
// per-session judgment records + the change ledger into one JSON payload and injects it into the
// shipped template's data slot. It adds NO metric and hand-writes NO chart code: the template owns
// all styling/charting (inline, offline), the renderer only fills `__DASHBOARD_DATA__`.

/** The exact sentinel the template carries in its `<script type="application/json">` data slot. */
const DATA_SLOT = "__DASHBOARD_DATA__";

const fp6 = (fp: string): string => fp.slice(0, 6);
const id8 = (id: string): string => id.slice(0, 8);

/** YYYY-MM-DD from epoch ms (UTC) — matches the text digest's date formatting. */
function shortDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// --- The dashboard data contract (what the template's inline JS consumes) ---

export interface DashboardData {
  meta: {
    generatedAt: number;
    windowLabel: string;
    workspaceLabel: string;
    sessionCount: number;
    fingerprintCount: number;
  };
  /** Section 1 — did my tuning help? */
  tuning: {
    groups: {
      fp6: string;
      sessions: number;
      from: string;
      to: string;
      version: string | null;
      avgPeakContext: number;
      avgFinalContext: number;
      contextWindowSize: number;
      avgCacheHitRatio: number;
      totalOutput: number;
      avgInstructionFootprint: number;
    }[];
    transitions: {
      from6: string;
      to6: string;
      changes: { kind: string; id: string; note: string | null }[];
      deltas: {
        avgPeakContext: number;
        avgCacheHitRatio: number;
        ruleViolations: number;
        errorToolResults: number;
        recallFollowedByRead: number;
      };
    }[];
    ledger: { ts: number; kind: string; id: string; note: string | null }[];
    judgments: {
      hasJudgments: boolean;
      total: number;
      byVerdict: Record<Verdict, number>;
    };
  };
  /** Section 2 — where's context leaking? */
  context: {
    sessions: {
      id8: string;
      workspace: string | null;
      mtimeMs: number;
      peakContext: number;
      finalContext: number;
      contextWindowSize: number;
      curve: number[];
      jumps: { turn: number; delta: number; driver: string | null }[];
    }[];
    toolSpend: { tool: string; approxTokens: number; count: number }[];
  };
  /** Section 3 — friction. */
  friction: {
    totals: {
      errors: number;
      ruleViolations: number;
      permissionDenials: number;
      corrections: number;
    };
    series: {
      id8: string;
      mtimeMs: number;
      errors: number;
      ruleViolations: number;
      permissionDenials: number;
      corrections: number;
    }[];
    /** Concrete samples of what actually went wrong (bounded), so the section isn't just counts. */
    details: {
      ruleViolations: { rule: string; detail: string }[];
      errors: { tool: string; snippet: string; permission: boolean }[];
      corrections: string[];
    };
  };
  /** Section 4 — knowledge health. */
  knowledge: {
    totalNotes: number;
    byScope: { topic: number; project: number };
    byRepo: { repo: string; count: number }[];
    confidence: { high: number; medium: number; low: number };
    confidenceUsage: { high: NoteUsage; medium: NoteUsage; low: NoteUsage };
    dead: number;
    stale: number;
    /** Names of notes never read/recalled (bounded list, for the attention card). */
    deadNotes: string[];
    /** Names + source dates of notes older than the staleness window (bounded list). */
    staleNotes: { name: string; date: string }[];
    rotted: { name: string; missing: string }[];
    orphanTags: string[];
    recall: { invocations: number; consumed: number; distinctNotesUsed: number };
  };
}

/** Used-vs-dead split for one confidence tier. */
interface NoteUsage {
  used: number;
  dead: number;
}

const TOP_JUMPS = 6;
const TOP_TOOLS = 12;
/** Caps on the bounded "what went wrong / what's at risk" detail lists (window-wide). */
const MAX_FRICTION_DETAILS = 12;
const MAX_KNOWLEDGE_NAMES = 20;

const ALL_VERDICTS: Verdict[] = ["justified", "wasteful", "neutral", "efficient", "inefficient"];

/** Sum the per-group tool buckets into one window-wide spend list (largest first). */
function mergeToolSpend(digest: Digest): DashboardData["context"]["toolSpend"] {
  const byTool = new Map<string, { approxTokens: number; count: number }>();
  for (const g of digest.groups) {
    for (const b of g.toolBuckets) {
      const cur = byTool.get(b.tool) ?? { approxTokens: 0, count: 0 };
      cur.approxTokens += b.approxTokens;
      cur.count += b.count;
      byTool.set(b.tool, cur);
    }
  }
  return [...byTool.entries()]
    .map(([tool, v]) => ({ tool, ...v }))
    .toSorted((a, b) => b.approxTokens - a.approxTokens || a.tool.localeCompare(b.tool))
    .slice(0, TOP_TOOLS);
}

/** Tally the Tier-2 verdicts across every session's judgment record. */
function tallyJudgments(judgments: JudgmentRecord[]): DashboardData["tuning"]["judgments"] {
  const byVerdict = Object.fromEntries(ALL_VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  let total = 0;
  for (const rec of judgments) {
    for (const j of rec.judgments) {
      byVerdict[j.verdict] = (byVerdict[j.verdict] ?? 0) + 1;
      total += 1;
    }
  }
  return { hasJudgments: total > 0, total, byVerdict };
}

/** The biggest context jumps for one session, in chronological order (when · how much · what). */
function biggestJumps(m: SessionMetrics): DashboardData["context"]["sessions"][number]["jumps"] {
  return m.tokens.contextCurve
    .filter((p) => p.delta > 0)
    .toSorted((a, b) => b.delta - a.delta)
    .slice(0, TOP_JUMPS)
    .toSorted((a, b) => a.turn - b.turn)
    .map((p) => ({ turn: p.turn, delta: p.delta, driver: p.drivers[0]?.tool ?? null }));
}

/**
 * Build the dashboard's JSON payload from the already-computed insights data. Pure: every field is
 * read straight off the digest / metrics records / judgment records / ledger — no metric is derived
 * here that the deterministic pass didn't already produce.
 */
export function buildDashboardData(opts: {
  digest: Digest;
  records: SessionMetrics[];
  judgments: JudgmentRecord[];
  changes: ChangeEntry[];
}): DashboardData {
  const { digest, records, judgments, changes } = opts;

  const byMtime = [...records].toSorted((a, b) => a.mtimeMs - b.mtimeMs);

  // Recall surfaced vs consumed: union of notes used (read ∪ recall-surfaced) and summed counts.
  const distinctNotes = new Set<string>();
  let recallInvocations = 0;
  let recallsConsumed = 0;
  for (const r of records) {
    for (const p of r.knowledge.knowledgeReads) distinctNotes.add(p);
    for (const p of r.knowledge.recallSurfacedNotes) distinctNotes.add(p);
    recallInvocations += r.knowledge.recallInvocations;
    recallsConsumed += r.knowledge.recallsConsumed;
  }

  const h = digest.knowledgeHealth;

  // Friction details: concrete samples pulled straight off the per-session records (bounded).
  const ruleViolationDetails: { rule: string; detail: string }[] = [];
  const errorDetails: { tool: string; snippet: string; permission: boolean }[] = [];
  const correctionDetails: string[] = [];
  for (const r of byMtime) {
    for (const v of r.instructions.ruleViolations) {
      if (ruleViolationDetails.length < MAX_FRICTION_DETAILS)
        ruleViolationDetails.push({ rule: v.rule, detail: v.detail });
    }
    for (const e of r.instructions.errorSamples) {
      if (errorDetails.length < MAX_FRICTION_DETAILS)
        errorDetails.push({ tool: e.tool, snippet: e.snippet, permission: e.permission });
    }
    for (const c of r.instructions.correctionSamples) {
      if (correctionDetails.length < MAX_FRICTION_DETAILS) correctionDetails.push(c);
    }
  }

  return {
    meta: {
      generatedAt: digest.generatedAt,
      windowLabel: digest.windowLabel,
      workspaceLabel: digest.workspaceLabel,
      sessionCount: digest.sessionCount,
      fingerprintCount: digest.groups.length,
    },
    tuning: {
      groups: digest.groups.map((g) => ({
        fp6: fp6(g.fingerprint),
        sessions: g.sessionCount,
        from: shortDate(g.earliestMtime),
        to: shortDate(g.latestMtime),
        version: g.version,
        avgPeakContext: Math.round(g.avgPeakContext),
        avgFinalContext: Math.round(g.avgFinalContext),
        contextWindowSize: g.contextWindowSize,
        avgCacheHitRatio: g.avgCacheHitRatio,
        totalOutput: g.totalOutput,
        avgInstructionFootprint: Math.round(g.avgInstructionFootprint),
      })),
      transitions: digest.transitions.map((t) => ({
        from6: fp6(t.fromFingerprint),
        to6: fp6(t.toFingerprint),
        changes: t.changes.map((c) => ({ kind: c.kind, id: c.id, note: c.note ?? null })),
        deltas: {
          avgPeakContext: Math.round(t.deltas.avgPeakContext),
          avgCacheHitRatio: t.deltas.avgCacheHitRatio,
          ruleViolations: t.deltas.ruleViolations,
          errorToolResults: t.deltas.errorToolResults,
          recallFollowedByRead: t.deltas.recallFollowedByRead,
        },
      })),
      ledger: [...changes]
        .toSorted((a, b) => a.ts - b.ts)
        .map((c) => ({ ts: c.ts, kind: c.kind, id: c.id, note: c.note ?? null })),
      judgments: tallyJudgments(judgments),
    },
    context: {
      sessions: byMtime.map((m) => ({
        id8: id8(m.sessionId),
        workspace: m.workspace,
        mtimeMs: m.mtimeMs,
        peakContext: m.tokens.peakContext,
        finalContext: m.tokens.finalContext,
        contextWindowSize: m.tokens.contextWindowSize,
        curve: m.tokens.contextCurve.map((p) => p.context),
        jumps: biggestJumps(m),
      })),
      toolSpend: mergeToolSpend(digest),
    },
    friction: {
      totals: digest.groups.reduce(
        (acc, g) => ({
          errors: acc.errors + g.errorToolResults,
          ruleViolations: acc.ruleViolations + g.ruleViolations,
          permissionDenials: acc.permissionDenials + g.permissionDenials,
          corrections: acc.corrections + g.userCorrections,
        }),
        { errors: 0, ruleViolations: 0, permissionDenials: 0, corrections: 0 },
      ),
      series: byMtime.map((m) => ({
        id8: id8(m.sessionId),
        mtimeMs: m.mtimeMs,
        errors: m.instructions.errorToolResults,
        ruleViolations: m.instructions.ruleViolations.length,
        permissionDenials: m.instructions.permissionDenials,
        corrections: m.instructions.userCorrections,
      })),
      details: {
        ruleViolations: ruleViolationDetails,
        errors: errorDetails,
        corrections: correctionDetails,
      },
    },
    knowledge: {
      totalNotes: h.totalNotes,
      byScope: h.byScope,
      byRepo: h.byRepo,
      confidence: h.confidence,
      confidenceUsage: h.confidenceUsage,
      dead: h.dead.length,
      stale: h.stale.length,
      deadNotes: h.dead.slice(0, MAX_KNOWLEDGE_NAMES).map((d) => d.name),
      staleNotes: h.stale
        .slice(0, MAX_KNOWLEDGE_NAMES)
        .map((sn) => ({ name: sn.name, date: sn.date })),
      rotted: h.rotted.map((r) => ({ name: r.name, missing: r.missing })),
      orphanTags: h.orphanTags,
      recall: {
        invocations: recallInvocations,
        consumed: recallsConsumed,
        distinctNotesUsed: distinctNotes.size,
      },
    },
  };
}

/**
 * Serialize the payload for safe embedding inside an HTML `<script>` block: `</` is broken so a
 * `</script>` inside any string can't close the tag early (`<\/script>` is still valid JSON).
 */
function encodeForScript(data: DashboardData): string {
  return JSON.stringify(data).replace(/<\//g, "<\\/");
}

/**
 * Render the full, self-contained dashboard HTML by injecting the data payload into the shipped
 * template's single data slot. Deterministic and offline: the returned string references no network
 * resource. Throws if the template asset somehow lacks the slot (a build/asset error, not user input).
 */
export function renderDashboard(opts: {
  digest: Digest;
  records: SessionMetrics[];
  judgments: JudgmentRecord[];
  changes: ChangeEntry[];
}): string {
  if (!DASHBOARD_TEMPLATE.includes(DATA_SLOT)) {
    throw new Error(`dashboard template is missing the ${DATA_SLOT} data slot`);
  }
  const data = buildDashboardData(opts);
  return DASHBOARD_TEMPLATE.replace(DATA_SLOT, encodeForScript(data));
}
