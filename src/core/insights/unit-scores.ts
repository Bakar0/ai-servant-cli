import type { InstructionUnitKind } from "./instruction-units.ts";
import type { JudgmentRecord, UnitJudgment } from "./judgments.ts";

// The read side of the units axis. Judgment records are per-session and stay that way; every
// aggregate over units, sources or time is computed here, on read — the same rule the skill store
// follows for drift, and for the same reason: a stored rollup is a second truth that goes stale.

/** One instruction unit's track record across every session that judged it. */
export interface UnitScore {
  id: string;
  kind: InstructionUnitKind;
  /** Sessions carrying a verdict for this unit. */
  sessions: number;
  /** Of those, how many actually invoked (skill) or read (doc) it. */
  invoked: number;
  justified: number;
  wasteful: number;
  neutral: number;
  /** `justified - wasteful` — the one number that answers "did it earn its place?". */
  net: number;
}

/** Tally per-unit verdicts across sessions. Insertion order follows first appearance. */
export function summarizeUnits(records: readonly JudgmentRecord[]): Map<string, UnitScore> {
  const out = new Map<string, UnitScore>();
  for (const rec of records) {
    for (const u of rec.units ?? []) tally(out, u);
  }
  for (const s of out.values()) s.net = s.justified - s.wasteful;
  return out;
}

function tally(out: Map<string, UnitScore>, u: UnitJudgment): void {
  const cur =
    out.get(u.id) ??
    ({
      id: u.id,
      kind: u.kind,
      sessions: 0,
      invoked: 0,
      justified: 0,
      wasteful: 0,
      neutral: 0,
      net: 0,
    } satisfies UnitScore);
  cur.sessions += 1;
  if (u.invoked) cur.invoked += 1;
  cur[u.verdict] += 1;
  out.set(u.id, cur);
}

/** How many sessions have produced a verdict for each unit id — the coverage the judge selects on. */
export function unitCoverage(records: readonly JudgmentRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const rec of records) {
    for (const u of rec.units ?? []) out.set(u.id, (out.get(u.id) ?? 0) + 1);
  }
  return out;
}

/** What a score column shows when nothing has judged the unit yet. */
export const UNSCORED = "—";

/**
 * What it shows for a unit no session can ever judge, because it never enters the agent's context.
 *
 * Distinct from {@link UNSCORED} on purpose: one dash for both causes cannot tell a reader "no data
 * yet" from "no data ever", and the second is not a measurement failure. A skill Claude Code never
 * lists is invisible to the model and `/`-invocable only — which also means it costs zero resident
 * tokens, arguably the right state for a skill a human triggers deliberately.
 */
export const UNJUDGEABLE = "n/a";

/**
 * Terse enough for a table column: the net verdict and the sample size behind it.
 *
 * `judgeable: false` marks a unit no session can score. A verdict already on record still wins —
 * a unit that used to be judgeable keeps the track record it earned.
 */
export function formatUnitScore(score: UnitScore | undefined, judgeable = true): string {
  if (!score || score.sessions === 0) return judgeable ? UNSCORED : UNJUDGEABLE;
  const net = score.net > 0 ? `+${score.net}` : `${score.net}`;
  return `${net}/${score.sessions}`;
}

/** The one-line breakdown behind the column, for a preview pane or a report row. */
export function describeUnitScore(score: UnitScore | undefined, judgeable = true): string {
  if (!score || score.sessions === 0) {
    return judgeable
      ? `${UNSCORED} (no session has judged it yet)`
      : `${UNJUDGEABLE} (never enters the agent's context, so no session can judge it — and it costs 0 resident tokens)`;
  }
  return [
    formatUnitScore(score, judgeable),
    `— ${score.justified} justified · ${score.wasteful} wasteful · ${score.neutral} neutral`,
    `over ${score.sessions} judged session(s), used in ${score.invoked}`,
  ].join(" ");
}

/** Every scored unit, worst first — the order an audit wants to read them in. */
export function rankUnits(scores: Map<string, UnitScore>): UnitScore[] {
  return [...scores.values()].toSorted(
    (a, b) => a.net - b.net || b.sessions - a.sessions || a.id.localeCompare(b.id),
  );
}
