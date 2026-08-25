import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_AGENT, getBackend } from "../../agents/index.ts";
import { headlessModelArgs } from "../headless-model.ts";
import { registerHeadlessSession } from "../headless-sessions.ts";
import { cacheDir, workspacesRoot } from "../paths.ts";
import { detectWorkspaceNameFromCwd, readWorkspaceAgent } from "../workspace.ts";
import {
  type InstructionUnit,
  type InstructionUnitKind,
  parseRegionUnitId,
} from "./instruction-units.ts";
import type { Candidate, CandidateKind, TranscriptAnchor } from "./metrics.ts";

// Tier 2 of the insights model: a headless agent reads ONLY the anchored spans of a session's
// deterministic Phase-0 candidates and emits a qualitative verdict per candidate. This module owns
// the judgment record shape, the anchor-keyed idempotency, the headless prompt, and the default
// `claude -p` runner. The pass is best-effort and never blocks a session (see the judge queue).

// Bumping this lets a future shape change invalidate stored judgment records.
// v2 adds the units axis: a verdict per instruction unit (skill or doc) the session ran with.
export const JUDGMENTS_SCHEMA_VERSION = 2;

/** Default cap on candidates judged per session (caps per-session token cost). Configurable. */
export const DEFAULT_MAX_JUDGE_CANDIDATES = 8;

/** Default cap on instruction units judged per session. */
export const DEFAULT_MAX_JUDGE_UNITS = 12;

/** Verdicts for footprint-style candidates (a large result / a context jump): worth it or not? */
export type FootprintVerdict = "justified" | "wasteful" | "neutral";
/** Verdicts for efficiency-style candidates (a skill/command, a repeated read, a correction). */
export type EfficiencyVerdict = "efficient" | "inefficient" | "neutral";
export type Verdict = FootprintVerdict | EfficiencyVerdict;

const FOOTPRINT_VERDICTS: readonly Verdict[] = ["justified", "wasteful", "neutral"];
const EFFICIENCY_VERDICTS: readonly Verdict[] = ["efficient", "inefficient", "neutral"];

/** The verdict vocabulary a given candidate kind is judged with. */
export function verdictsForKind(kind: CandidateKind): readonly Verdict[] {
  return kind === "large-tool-result" || kind === "context-jump"
    ? FOOTPRINT_VERDICTS
    : EFFICIENCY_VERDICTS;
}

/** Approx tokens a candidate represents (token kinds carry tokens; count kinds don't). */
function tokensForCandidate(c: Candidate): number {
  return c.kind === "large-tool-result" || c.kind === "context-jump" ? c.magnitude : 0;
}

/** A qualitative read of one candidate. The `anchor` is the dedup/identity key across re-runs. */
export interface Judgment {
  /** The judged candidate's transcript anchor — the identity key (an anchor is judged at most once). */
  anchor: TranscriptAnchor;
  /** The candidate kind judged (carried so a reader needn't re-derive it from the metrics record). */
  kind: CandidateKind;
  verdict: Verdict;
  /** Short, factual reasoning from the agent (no fluff). */
  reasoning: string;
  /** Approximate tokens involved (0 for count-based kinds where tokens don't apply). */
  tokens: number;
}

/**
 * A verdict on one instruction unit the session ran with: did loading it earn its cost?
 *
 * `invoked` is the mechanical half, carried so a reader never has to re-derive it — and it is not
 * the verdict. A skill nobody called may still have been right to load, and a doc is never
 * "invoked" at all, so a `wasteful` verdict has to be argued in `why`, not read off `invoked`.
 */
export interface UnitJudgment {
  /** The unit's stable id: a skill's invocation name, or a namespaced doc path. */
  id: string;
  kind: InstructionUnitKind;
  invoked: boolean;
  verdict: FootprintVerdict;
  /** Short, factual reasoning from the agent (no fluff). */
  why: string;
}

/** Per-session judgment record, a sibling to the metrics record in the insights store. */
export interface JudgmentRecord {
  schema: number;
  sessionId: string;
  judgments: Judgment[];
  /**
   * Per-unit verdicts for this session's *starting* instruction set. Per session only — every
   * aggregate over units, sources or time is computed on read, never stored.
   */
  units: UnitJudgment[];
}

/** Stable identity for an anchor — the dedup key that makes the judgment pass idempotent. */
export function anchorKey(a: TranscriptAnchor): string {
  return `${a.turnUuid ?? ""}|${a.toolUseId ?? ""}|${a.line ?? ""}`;
}

/**
 * Choose which candidates this run should judge: the highest-magnitude ones not already judged,
 * bounded so the *total* judged per session never exceeds `cap`. Returns [] when nothing is new
 * (the no-op case) or the cap is already spent. `candidates` is assumed magnitude-sorted (it is, as
 * produced by the metrics extractor).
 */
export function selectCandidatesToJudge(
  candidates: Candidate[],
  alreadyJudged: Judgment[],
  cap: number,
): Candidate[] {
  const slots = cap - alreadyJudged.length;
  if (slots <= 0) return [];
  const judged = new Set(alreadyJudged.map((j) => anchorKey(j.anchor)));
  const fresh = candidates.filter((c) => !judged.has(anchorKey(c.anchor)));
  return fresh.slice(0, slots);
}

/** Append freshly-produced judgments to the existing set, de-duplicating by anchor. */
export function mergeJudgments(existing: Judgment[], fresh: Judgment[]): Judgment[] {
  const seen = new Set(existing.map((j) => anchorKey(j.anchor)));
  return [...existing, ...fresh.filter((j) => !seen.has(anchorKey(j.anchor)))];
}

/**
 * Choose which instruction units this run should judge: the least-covered not-yet-judged ones
 * servant has a lever on, bounded by `cap`.
 *
 * `isJudgeable` is what keeps the pass affordable and the verdicts actionable — a session can load
 * dozens of skills servant neither installed nor can disable, and a verdict with no lever behind it
 * is a token spent for nothing. The full inventory stays in the metrics record either way.
 *
 * `priorVerdicts` is what makes the cap fair over time rather than only cheap. Size-descending
 * alone re-judges the same big units every session: simulated over 27 sessions, `code-review` took
 * a slot in 27 of them and `unslop` in none, so a small unit's verdict was unreachable no matter how
 * many sessions ran. Fewest verdicts first, then costliest — so a session spends its slots on what
 * is still unknown, and the cap stays where it is.
 */
export function selectUnitsToJudge(
  units: InstructionUnit[],
  alreadyJudged: UnitJudgment[],
  cap: number,
  opts: {
    isJudgeable?: (unit: InstructionUnit) => boolean;
    /** Unit id → sessions that already carry a verdict for it. Computed on read, never stored. */
    priorVerdicts?: ReadonlyMap<string, number>;
  } = {},
): InstructionUnit[] {
  const slots = cap - alreadyJudged.length;
  if (slots <= 0) return [];
  const isJudgeable = opts.isJudgeable ?? (() => true);
  const priors = opts.priorVerdicts ?? new Map<string, number>();
  const judged = new Set(alreadyJudged.map((u) => u.id));
  return units
    .filter((u) => !judged.has(u.id) && isJudgeable(u))
    .toSorted(
      (a, b) =>
        (priors.get(a.id) ?? 0) - (priors.get(b.id) ?? 0) || b.approxTokens - a.approxTokens,
    )
    .slice(0, slots);
}

/** Append freshly-produced unit verdicts to the existing set, de-duplicating by unit id. */
export function mergeUnitJudgments(
  existing: UnitJudgment[],
  fresh: UnitJudgment[],
): UnitJudgment[] {
  const seen = new Set(existing.map((u) => u.id));
  return [...existing, ...fresh.filter((u) => !seen.has(u.id))];
}

/** Coerce an agent-supplied string to a valid verdict for the kind (defaults to "neutral"). */
function coerceVerdict(kind: CandidateKind, raw: unknown): Verdict {
  const allowed = verdictsForKind(kind);
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as Verdict)
    : "neutral";
}

/** Parse the outermost `open`…`close` span of a blob, ignoring any prose or fences around it. */
function parseSpan(raw: string, open: string, close: string): unknown {
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Split the agent's output file into its two arrays. The prompt asks for
 * `{ "candidates": [...], "units": [...] }`; a bare array is still accepted as the candidates list,
 * so an agent that answers only the moment half loses the units half rather than everything.
 */
function splitJudgeOutput(raw: string): { candidates: unknown[]; units: unknown[] } {
  const obj = parseSpan(raw, "{", "}");
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const o = obj as { candidates?: unknown; units?: unknown };
    if ("candidates" in o || "units" in o) {
      return {
        candidates: Array.isArray(o.candidates) ? o.candidates : [],
        units: Array.isArray(o.units) ? o.units : [],
      };
    }
  }
  const arr = parseSpan(raw, "[", "]");
  return { candidates: Array.isArray(arr) ? arr : [], units: [] };
}

/**
 * Parse the agent's candidate verdicts — `{ index, verdict, reasoning }` entries referencing the
 * candidate list it was given — into full `Judgment`s. Tolerant: ignores prose/fences, skips
 * malformed entries, and joins each entry back to its candidate by index (so the anchor/kind/tokens
 * come from our deterministic data, never the agent).
 */
export function parseJudgments(raw: string, candidates: Candidate[]): Judgment[] {
  const arr = splitJudgeOutput(raw).candidates;
  const out: Judgment[] = [];
  const used = new Set<number>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const { index, verdict, reasoning } = item as {
      index?: unknown;
      verdict?: unknown;
      reasoning?: unknown;
    };
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (index < 0 || index >= candidates.length || used.has(index)) continue;
    const cand = candidates[index];
    if (!cand) continue;
    used.add(index);
    out.push({
      anchor: cand.anchor,
      kind: cand.kind,
      verdict: coerceVerdict(cand.kind, verdict),
      reasoning: typeof reasoning === "string" ? reasoning.trim().slice(0, 280) : "",
      tokens: tokensForCandidate(cand),
    });
  }
  return out;
}

/**
 * Parse the agent's unit verdicts — `{ index, verdict, why }` entries referencing the unit list it
 * was given — into `UnitJudgment`s. The id, kind and `invoked` come from our deterministic data, so
 * the agent only supplies the judgment it was asked for.
 */
export function parseUnitJudgments(raw: string, units: InstructionUnit[]): UnitJudgment[] {
  const arr = splitJudgeOutput(raw).units;
  const out: UnitJudgment[] = [];
  const used = new Set<number>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const { index, verdict, why } = item as { index?: unknown; verdict?: unknown; why?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (index < 0 || index >= units.length || used.has(index)) continue;
    const unit = units[index];
    if (!unit) continue;
    used.add(index);
    out.push({
      id: unit.id,
      kind: unit.kind,
      invoked: unit.uses > 0,
      verdict:
        typeof verdict === "string" && (FOOTPRINT_VERDICTS as readonly string[]).includes(verdict)
          ? (verdict as FootprintVerdict)
          : "neutral",
      why: typeof why === "string" ? why.trim().slice(0, 280) : "",
    });
  }
  return out;
}

/** One unit as the judge sees it: what it cost, whether it fired, and whether it started loaded. */
function describeUnit(u: InstructionUnit): string {
  const cost = u.resident
    ? `~${u.approxTokens} tok resident every turn`
    : `~${u.approxTokens} tok, only if read`;
  const used = u.kind === "doc" ? `read ${u.uses}×` : `invoked ${u.uses}×`;
  const start = u.fromStart ? "in the starting set" : "loaded mid-session";
  const region = u.kind === "doc" ? parseRegionUnitId(u.id) : null;
  const part = region
    ? `, a generated region inside ${region.docId} (servant renders it; nobody wrote it by hand)`
    : "";
  return `${u.kind} ${u.id} — ${cost}, ${used}, ${start}${part}`;
}

/**
 * The headless judging prompt. The agent is told to read ONLY the anchored spans (not the whole
 * transcript) and to write both verdict sets as one JSON object to `outPath`. Candidates and units
 * are numbered so the agent only emits an index plus its judgment — we rebuild the rest
 * deterministically, so no identity ever depends on what the agent typed.
 */
export function buildJudgePrompt(opts: {
  transcriptPath: string;
  candidates: Candidate[];
  units: InstructionUnit[];
  outPath: string;
}): string {
  const list = opts.candidates
    .map((c, i) => {
      const a = c.anchor;
      const loc = a.line ? `line ${a.line}` : "line ?";
      const verdicts = verdictsForKind(c.kind).join(" | ");
      return `[${i}] kind=${c.kind} (${loc}${a.toolUseId ? `, tool_use_id=${a.toolUseId}` : ""}) — ${c.summary}\n     verdict ∈ { ${verdicts} }`;
    })
    .join("\n");

  const unitList = opts.units.map((u, i) => `[u${i}] ${describeUnit(u)}`).join("\n");

  return `You are the servant insights judge running headlessly. A just-ended coding session was scanned deterministically and a few moments were flagged as worth a qualitative read. Judge each one, then judge the instruction units the session ran with. Do not converse — do the work and stop.

## Source
- Transcript (JSONL): ${opts.transcriptPath}

## How to read (IMPORTANT — cost control)
Read ONLY the spans the candidates point to, NOT the whole transcript. Each candidate gives a 1-based line number; use the Read tool with an \`offset\`/\`limit\` window around that line (e.g. a few lines before and after) to see the moment and its immediate context. Do not read the entire file.

## Candidates to judge
${list}

## What a candidate verdict means
- For footprint moments (large-tool-result, context-jump): was the context it cost **justified** by what it contributed, **wasteful**, or **neutral**?
- For efficiency moments (skill-or-command, repeated-read, user-correction, rule-violation): was the action **efficient** (did its job cleanly), **inefficient** (friction / waste), or **neutral**?
Pick from the per-candidate vocabulary shown above. Keep reasoning to one short, factual sentence.

## Instruction units to judge
An **instruction unit** is anything loaded to shape the session: a skill, or an agent instruction document. Each line gives what it cost, how often it fired, and whether it was loaded from the start.

${unitList || "(none)"}

## What a unit verdict means
One question per unit: **was loading this worth what it cost this session?** Answer **justified**, **wasteful**, or **neutral**, and say why in one short sentence.

Judge it honestly, and specifically **not** by whether it fired:
- A skill that was never invoked can still be **justified** — it was a reasonable thing to have available for the work this session turned out to be. It is **wasteful** only when nothing about this session's work could plausibly have needed it.
- A resident cost is paid every single turn, invoked or not. That is what makes a large, irrelevant unit wasteful even though it did no harm.
- An instruction document is never "invoked". Judge it on whether the session's work needed the guidance it carries, and whether the session's behaviour actually reflected it.
- A resident document that the session went and **read again** is evidence its guidance did not stick — that leans wasteful, or at least says the doc is not doing its job where it sits.
- A doc marked "a generated region inside <doc>" is a block servant renders into that doc, and it is listed separately from the doc's own prose because the two have different levers. Judge it on its own: did *this payload* earn the tokens it costs every turn? Do not let the surrounding document's usefulness answer for it, and do not judge the parent doc on the payload's size.
- A unit marked "only if read" cost nothing unless it was read. Never call that one wasteful for sitting unread; judge whether it was worth reading when it was, and stay **neutral** when it was not touched.
- "Loaded mid-session" means it was not part of the starting set — judge only what it cost from then on.
- Use **neutral** when the session genuinely gives you nothing to go on. Do not guess.

## Output
Write ONE JSON object to this exact path: ${opts.outPath}
{
  "candidates": [ { "index": <candidate number>, "verdict": "<allowed verdict>", "reasoning": "<one short sentence>" } ],
  "units": [ { "index": <unit number, the digits after "u">, "verdict": "justified | wasteful | neutral", "why": "<one short sentence>" } ]
}
Judge every candidate and every unit you can; omit any you genuinely cannot assess. Write ONLY the file, then stop.`;
}

/**
 * Runs the headless judging step for one session and returns the parsed judgments plus the headless
 * run's own session id (so the caller/runner can exclude it from measurement). Injectable so tests
 * can supply canned judgments without spawning `claude`.
 */
export type JudgeRunner = (input: {
  job: { transcript_path: string; cwd: string; session_id: string };
  candidates: Candidate[];
  units: InstructionUnit[];
}) => Promise<{ sessionId: string | null; judgments: Judgment[]; units: UnitJudgment[] }>;

/**
 * Default runner: spawns `claude -p` over the anchored spans. It generates the headless session id
 * up front and registers it as servant-headless BEFORE spawning, so the run is excluded from
 * measurement even if it crashes. `SERVANT_INSIGHTS=1` is the re-entry guard (the run's own
 * SessionEnd hook sees it and never re-enqueues). Best-effort; throws only when it produced nothing.
 */
/**
 * Argv for the headless judge `claude -p`. `headlessModelArgs()` injects `--model` (default
 * `sonnet`) — see ADR-005. Exported so tests can assert the headless model without spawning claude.
 */
export function judgeArgv(
  prompt: string,
  sessionId: string,
  backendName = "claude-code",
): string[] {
  return getBackend(backendName).headless.judgeArgv(prompt, {
    modelArgs: headlessModelArgs(backendName),
    addDir: cacheDir(),
    sessionId,
  });
}

export const defaultJudgeRunner: JudgeRunner = async ({ job, candidates, units }) => {
  const workspace = detectWorkspaceNameFromCwd(job.cwd, workspacesRoot());
  const backendName = (workspace ? await readWorkspaceAgent(workspace) : null) ?? DEFAULT_AGENT;
  const backend = getBackend(backendName);
  // `runId` names the temp output file. For `"session-id"` backends (Claude) it's also the headless
  // run's session id, registered up-front so the run is excluded from measurement even on a crash.
  // For `"ephemeral"` backends (Codex) the run never persists a session, so there's nothing to
  // register or exclude (excludeId stays null).
  const runId = crypto.randomUUID();
  let excludeId: string | null = null;
  if (backend.headless.selfExclusion === "session-id") {
    await registerHeadlessSession(runId);
    excludeId = runId;
  }
  const outPath = join(cacheDir(), `judge-out-${runId}.json`);
  const prompt = buildJudgePrompt({
    transcriptPath: job.transcript_path,
    candidates,
    units,
    outPath,
  });
  const proc = Bun.spawn(judgeArgv(prompt, runId, backendName), {
    cwd: job.cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, SERVANT_INSIGHTS: "1" },
  });
  const code = await proc.exited;
  let raw = "";
  try {
    raw = await Bun.file(outPath).text();
  } catch {
    // agent wrote nothing
  }
  await rm(outPath, { force: true });
  if (!raw) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${backendName} judge exited ${code}: ${err.trim().slice(0, 200)}`);
  }
  return {
    sessionId: excludeId,
    judgments: parseJudgments(raw, candidates),
    units: parseUnitJudgments(raw, units),
  };
};
