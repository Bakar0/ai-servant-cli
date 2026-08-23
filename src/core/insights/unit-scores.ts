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

/** What a score column shows when nothing has judged the unit yet. */
export const UNSCORED = "—";

/** Terse enough for a table column: the net verdict and the sample size behind it. */
export function formatUnitScore(score: UnitScore | undefined): string {
  if (!score || score.sessions === 0) return UNSCORED;
  const net = score.net > 0 ? `+${score.net}` : `${score.net}`;
  return `${net}/${score.sessions}`;
}

/** The one-line breakdown behind the column, for a preview pane or a report row. */
export function describeUnitScore(score: UnitScore | undefined): string {
  if (!score || score.sessions === 0) {
    return `${UNSCORED} (no session has judged it yet)`;
  }
  return [
    formatUnitScore(score),
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
