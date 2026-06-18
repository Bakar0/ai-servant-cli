import type { KnowledgeHealth } from "./knowledge-health.ts";
import type { SessionMetrics } from "./metrics.ts";
import type { ChangeEntry } from "./changes.ts";

// Roll metric records up into a human report, segmented by setup fingerprint and aligned to the
// change ledger so it reads as a before/after timeline. Pure functions: `buildDigest` aggregates,
// `renderDigest` formats. The command supplies the records, changes, and a knowledge-health scan.

export type Area = "tokens" | "instructions" | "knowledge";

export interface FingerprintGroup {
  fingerprint: string;
  sessionCount: number;
  earliestMtime: number;
  latestMtime: number;
  version: string | null;
  // tokens
  avgPeakContext: number;
  avgFinalContext: number;
  contextWindowSize: number;
  avgCacheHitRatio: number;
  totalOutput: number;
  compactionEvents: number;
  avgInstructionFootprint: number;
  toolBuckets: { tool: string; chars: number; approxTokens: number; count: number }[];
  // instructions
  slashCommands: { name: string; count: number }[];
  ruleViolations: number;
  errorToolResults: number;
  permissionDenials: number;
  userCorrections: number;
  // knowledge
  recallInvocations: number;
  recallFollowedByRead: number;
  distinctKnowledgeReads: number;
}

export interface Transition {
  fromFingerprint: string;
  toFingerprint: string;
  changes: ChangeEntry[];
  deltas: {
    avgPeakContext: number;
    avgCacheHitRatio: number;
    ruleViolations: number;
    errorToolResults: number;
    recallFollowedByRead: number;
  };
}

export interface Digest {
  generatedAt: number;
  sessionCount: number;
  windowLabel: string;
  workspaceLabel: string;
  groups: FingerprintGroup[];
  transitions: Transition[];
  knowledgeHealth: KnowledgeHealth;
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function aggregateGroup(fingerprint: string, recs: SessionMetrics[]): FingerprintGroup {
  const buckets = new Map<string, { chars: number; approxTokens: number; count: number }>();
  const slash = new Map<string, number>();
  const reads = new Set<string>();
  for (const r of recs) {
    for (const b of r.tokens.toolBuckets) {
      const cur = buckets.get(b.tool) ?? { chars: 0, approxTokens: 0, count: 0 };
      cur.chars += b.chars;
      cur.approxTokens += b.approxTokens;
      cur.count += b.count;
      buckets.set(b.tool, cur);
    }
    for (const c of r.instructions.slashCommands)
      slash.set(c.name, (slash.get(c.name) ?? 0) + c.count);
    for (const p of r.knowledge.knowledgeReads) reads.add(p);
  }
  return {
    fingerprint,
    sessionCount: recs.length,
    earliestMtime: Math.min(...recs.map((r) => r.mtimeMs)),
    latestMtime: Math.max(...recs.map((r) => r.mtimeMs)),
    version: recs.find((r) => r.version)?.version ?? null,
    avgPeakContext: avg(recs.map((r) => r.tokens.peakContext)),
    avgFinalContext: avg(recs.map((r) => r.tokens.finalContext)),
    contextWindowSize: Math.max(...recs.map((r) => r.tokens.contextWindowSize)),
    avgCacheHitRatio: avg(recs.map((r) => r.tokens.cacheHitRatio)),
    totalOutput: recs.reduce((a, r) => a + r.tokens.totalOutput, 0),
    compactionEvents: recs.reduce((a, r) => a + r.tokens.compactionEvents, 0),
    avgInstructionFootprint: avg(recs.map((r) => r.tokens.instructionFootprintTokens)),
    toolBuckets: [...buckets.entries()]
      .map(([tool, v]) => ({ tool, ...v }))
      .toSorted((a, b) => b.chars - a.chars),
    slashCommands: [...slash.entries()]
      .map(([name, count]) => ({ name, count }))
      .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    ruleViolations: recs.reduce((a, r) => a + r.instructions.ruleViolations.length, 0),
    errorToolResults: recs.reduce((a, r) => a + r.instructions.errorToolResults, 0),
    permissionDenials: recs.reduce((a, r) => a + r.instructions.permissionDenials, 0),
    userCorrections: recs.reduce((a, r) => a + r.instructions.userCorrections, 0),
    recallInvocations: recs.reduce((a, r) => a + r.knowledge.recallInvocations, 0),
    recallFollowedByRead: recs.reduce((a, r) => a + r.knowledge.recallFollowedByRead, 0),
    distinctKnowledgeReads: reads.size,
  };
}

export function buildDigest(opts: {
  records: SessionMetrics[];
  changes: ChangeEntry[];
  knowledgeHealth: KnowledgeHealth;
  now: number;
  windowLabel: string;
  workspaceLabel: string;
}): Digest {
  const byFingerprint = new Map<string, SessionMetrics[]>();
  for (const r of opts.records) {
    const arr = byFingerprint.get(r.setupFingerprint) ?? [];
    arr.push(r);
    byFingerprint.set(r.setupFingerprint, arr);
  }

  const groups = [...byFingerprint.entries()]
    .map(([fp, recs]) => aggregateGroup(fp, recs))
    .toSorted((a, b) => a.earliestMtime - b.earliestMtime);

  const transitions: Transition[] = [];
  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1];
    const cur = groups[i];
    if (!prev || !cur) continue;
    // Ledger entries that fall in the gap between the two groups explain the transition.
    const changes = opts.changes.filter(
      (c) => c.ts > prev.latestMtime && c.ts <= cur.earliestMtime,
    );
    transitions.push({
      fromFingerprint: prev.fingerprint,
      toFingerprint: cur.fingerprint,
      changes,
      deltas: {
        avgPeakContext: cur.avgPeakContext - prev.avgPeakContext,
        avgCacheHitRatio: cur.avgCacheHitRatio - prev.avgCacheHitRatio,
        ruleViolations: cur.ruleViolations - prev.ruleViolations,
        errorToolResults: cur.errorToolResults - prev.errorToolResults,
        recallFollowedByRead: cur.recallFollowedByRead - prev.recallFollowedByRead,
      },
    });
  }

  return {
    generatedAt: opts.now,
    sessionCount: opts.records.length,
    windowLabel: opts.windowLabel,
    workspaceLabel: opts.workspaceLabel,
    groups,
    transitions,
    knowledgeHealth: opts.knowledgeHealth,
  };
}

// --- Rendering ---

const fp6 = (fp: string): string => fp.slice(0, 6);
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

function shortDate(ts: number): string {
  // YYYY-MM-DD from epoch ms, UTC — deterministic and tz-stable for the digest header.
  return new Date(ts).toISOString().slice(0, 10);
}

function renderTokens(g: FingerprintGroup, lines: string[]): void {
  lines.push(
    `    tokens:  peak ctx ~${k(g.avgPeakContext)} · final ~${k(g.avgFinalContext)} · cache hit ${pct(g.avgCacheHitRatio)} · out ${k(g.totalOutput)} · footprint ~${k(g.avgInstructionFootprint)} tok`,
  );
  if (g.compactionEvents > 0) lines.push(`             compactions: ${g.compactionEvents}`);
  const top = g.toolBuckets.slice(0, 4);
  if (top.length) {
    lines.push(
      `             window eaters: ${top.map((b) => `${b.tool} ~${k(b.approxTokens)}tok`).join(" · ")}`,
    );
  }
}

function renderInstructions(g: FingerprintGroup, lines: string[]): void {
  const cmds = g.slashCommands.length
    ? g.slashCommands.map((c) => `${c.name}×${c.count}`).join(" ")
    : "none";
  lines.push(`    instr:   /servant cmds: ${cmds}`);
  lines.push(
    `             rule violations: ${g.ruleViolations} · tool errors: ${g.errorToolResults} · perm denials: ${g.permissionDenials} · corrections: ${g.userCorrections}`,
  );
}

function renderKnowledge(g: FingerprintGroup, lines: string[]): void {
  lines.push(
    `    know:    recalls: ${g.recallInvocations} (consumed: ${g.recallFollowedByRead}) · distinct notes read: ${g.distinctKnowledgeReads}`,
  );
}

export function renderDigest(d: Digest, opts: { area?: Area } = {}): string {
  const area = opts.area;
  const lines: string[] = [];
  lines.push("servant insights");
  lines.push(
    `  ${d.sessionCount} session(s) · ${d.workspaceLabel} · ${d.windowLabel} · ${d.groups.length} setup fingerprint(s)`,
  );

  if (d.sessionCount === 0) {
    lines.push("");
    lines.push("  No servant sessions in this window yet — spawn a workspace and come back.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("setup timeline (oldest → newest):");
  for (const g of d.groups) {
    const ver = g.version ? ` · cc ${g.version}` : "";
    lines.push(
      `  ▸ ${fp6(g.fingerprint)} — ${g.sessionCount} session(s), ${shortDate(g.earliestMtime)}→${shortDate(g.latestMtime)}${ver}`,
    );
    if (!area || area === "tokens") renderTokens(g, lines);
    if (!area || area === "instructions") renderInstructions(g, lines);
    if (!area || area === "knowledge") renderKnowledge(g, lines);
  }

  if (d.transitions.length) {
    lines.push("");
    lines.push("before/after (what moved between setups):");
    for (const t of d.transitions) {
      lines.push(`  ${fp6(t.fromFingerprint)} → ${fp6(t.toFingerprint)}`);
      if (t.changes.length) {
        for (const c of t.changes) {
          lines.push(`    change: ${c.kind} ${c.id}${c.note ? ` — ${c.note}` : ""}`);
        }
      } else {
        lines.push("    change: (no ledger entry — setup changed outside servant)");
      }
      lines.push(
        `    Δ peak ctx ${signed(Math.round(t.deltas.avgPeakContext))} · Δ cache hit ${signed(Math.round(t.deltas.avgCacheHitRatio * 100))}pp · Δ rule viol ${signed(t.deltas.ruleViolations)} · Δ tool errors ${signed(t.deltas.errorToolResults)}`,
      );
    }
  }

  if (!area || area === "knowledge") {
    const h = d.knowledgeHealth;
    lines.push("");
    lines.push("knowledge base health:");
    lines.push(
      `  ${h.totalNotes} notes (${h.byScope.project} project / ${h.byScope.topic} topic) · confidence ${h.confidence.high}H/${h.confidence.medium}M/${h.confidence.low}L`,
    );
    if (h.dead.length) lines.push(`  dead (never recalled/read): ${h.dead.length}`);
    if (h.stale.length) lines.push(`  stale (>6mo): ${h.stale.length}`);
    if (h.rotted.length)
      lines.push(`  rotted (cite a missing file): ${h.rotted.map((r) => r.name).join(", ")}`);
    if (h.orphanTags.length) lines.push(`  orphan tags (count 1): ${h.orphanTags.join(" ")}`);
  }

  return lines.join("\n");
}

// --- Single-session token timeline (how the context window grows, when, and what drives it) ---

const SPARK = "▁▂▃▄▅▆▇█";
const TOP_JUMPS = 6;

/** A unicode sparkline of the context curve, scaled to its own peak. */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))])
    .join("");
}

const driverLabel = (d: { tool: string; approxTokens: number }): string =>
  `${d.tool} ~${k(d.approxTokens)}`;

/**
 * Render one session's token story: the context-growth curve (with a sparkline), the biggest jumps
 * and what tool results drove each, and the whole-session token spend bucketed by tool.
 */
export function renderSessionTimeline(m: SessionMetrics): string {
  const t = m.tokens;
  const lines: string[] = [];
  lines.push(`servant insights — session ${m.sessionId}`);
  const ver = m.version ? ` · cc ${m.version}` : "";
  const ws = m.workspace ? `workspace ${m.workspace}` : "unknown workspace";
  lines.push(
    `  ${ws}${ver} · ${t.contextCurve.length} turns · peak ~${k(t.peakContext)} · final ~${k(t.finalContext)} · out ${k(t.totalOutput)}`,
  );

  if (t.contextCurve.length === 0) {
    lines.push("");
    lines.push("  No token-usage turns recorded for this session.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`context curve (turn 1→${t.contextCurve.length}):`);
  lines.push(`  ${sparkline(t.contextCurve.map((p) => p.context))}`);
  lines.push(
    `  start ~${k(t.contextCurve[0]?.context ?? 0)} → peak ~${k(t.peakContext)} → final ~${k(t.finalContext)}`,
  );

  // The jumps are where the context grew — "when" (turn) and "what" (driver tools).
  const jumps = t.contextCurve
    .filter((p) => p.delta > 0)
    .toSorted((a, b) => b.delta - a.delta)
    .slice(0, TOP_JUMPS);
  if (jumps.length) {
    lines.push("");
    lines.push("biggest context jumps (when · how much · what drove it):");
    for (const p of jumps.toSorted((a, b) => a.turn - b.turn)) {
      const drivers = p.drivers.length
        ? p.drivers.slice(0, 3).map(driverLabel).join(" · ")
        : "(prompt/output, no tool result)";
      lines.push(`  t${p.turn}  +${k(p.delta)}  →  ${drivers}`);
    }
  }

  if (t.toolBuckets.length) {
    lines.push("");
    lines.push("token spend by tool (whole session, tool-result payloads):");
    for (const b of t.toolBuckets.slice(0, 8)) {
      lines.push(
        `  ${b.tool.padEnd(24)} ~${k(b.approxTokens).padStart(7)}  (${b.count} result(s))`,
      );
    }
  }

  if (t.topToolResults.length) {
    lines.push("");
    lines.push("single largest tool results:");
    for (const r of t.topToolResults) {
      lines.push(
        `  ~${k(r.approxTokens).padStart(7)}  ${r.tool}${r.target ? ` — ${r.target}` : ""}`,
      );
    }
  }

  return lines.join("\n");
}
