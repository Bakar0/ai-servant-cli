import { rm } from "node:fs/promises";
import { join } from "node:path";
import { headlessModelArgs } from "../headless-model.ts";
import { registerHeadlessSession } from "../headless-sessions.ts";
import { cacheDir } from "../paths.ts";
import type { Candidate, CandidateKind, TranscriptAnchor } from "./metrics.ts";

// Tier 2 of the insights model: a headless agent reads ONLY the anchored spans of a session's
// deterministic Phase-0 candidates and emits a qualitative verdict per candidate. This module owns
// the judgment record shape, the anchor-keyed idempotency, the headless prompt, and the default
// `claude -p` runner. The pass is best-effort and never blocks a session (see the judge queue).

// Bumping this lets a future shape change invalidate stored judgment records.
export const JUDGMENTS_SCHEMA_VERSION = 1;

/** Default cap on candidates judged per session (caps per-session token cost). Configurable. */
export const DEFAULT_MAX_JUDGE_CANDIDATES = 8;

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

/** Per-session judgment record, a sibling to the metrics record in the insights store. */
export interface JudgmentRecord {
  schema: number;
  sessionId: string;
  judgments: Judgment[];
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

/** Coerce an agent-supplied string to a valid verdict for the kind (defaults to "neutral"). */
function coerceVerdict(kind: CandidateKind, raw: unknown): Verdict {
  const allowed = verdictsForKind(kind);
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as Verdict)
    : "neutral";
}

/**
 * Parse the agent's output — a JSON array of `{ index, verdict, reasoning }` referencing the
 * candidate list it was given — into full `Judgment`s. Tolerant: ignores prose/fences around the
 * array, skips malformed entries, and joins each entry back to its candidate by index (so the
 * anchor/kind/tokens come from our deterministic data, never the agent).
 */
export function parseJudgments(raw: string, candidates: Candidate[]): Judgment[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
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
 * The headless judging prompt. The agent is told to read ONLY the anchored spans (not the whole
 * transcript) and to write its verdicts as a JSON array to `outPath`. Each candidate is numbered so
 * the agent only has to emit `{ index, verdict, reasoning }` — we rebuild the rest deterministically.
 */
export function buildJudgePrompt(opts: {
  transcriptPath: string;
  candidates: Candidate[];
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

  return `You are the servant insights judge running headlessly. A just-ended coding session was scanned deterministically and a few moments were flagged as worth a qualitative read. Judge each one. Do not converse — do the work and stop.

## Source
- Transcript (JSONL): ${opts.transcriptPath}

## How to read (IMPORTANT — cost control)
Read ONLY the spans the candidates point to, NOT the whole transcript. Each candidate gives a 1-based line number; use the Read tool with an \`offset\`/\`limit\` window around that line (e.g. a few lines before and after) to see the moment and its immediate context. Do not read the entire file.

## Candidates to judge
${list}

## What a verdict means
- For footprint moments (large-tool-result, context-jump): was the context it cost **justified** by what it contributed, **wasteful**, or **neutral**?
- For efficiency moments (skill-or-command, repeated-read, user-correction, rule-violation): was the action **efficient** (did its job cleanly), **inefficient** (friction / waste), or **neutral**?
Pick from the per-candidate vocabulary shown above. Keep reasoning to one short, factual sentence.

## Output
Write a JSON array to this exact path: ${opts.outPath}
Each element: { "index": <candidate number>, "verdict": "<one of the allowed verdicts>", "reasoning": "<one short sentence>" }
Judge every candidate you can; omit any you genuinely cannot assess. Write ONLY the file, then stop.`;
}

/**
 * Runs the headless judging step for one session and returns the parsed judgments plus the headless
 * run's own session id (so the caller/runner can exclude it from measurement). Injectable so tests
 * can supply canned judgments without spawning `claude`.
 */
export type JudgeRunner = (input: {
  job: { transcript_path: string; cwd: string; session_id: string };
  candidates: Candidate[];
}) => Promise<{ sessionId: string | null; judgments: Judgment[] }>;

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
export function judgeArgv(prompt: string, sessionId: string): string[] {
  return [
    "claude",
    "-p",
    prompt,
    ...headlessModelArgs(),
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--session-id",
    sessionId,
    "--add-dir",
    cacheDir(),
  ];
}

export const defaultJudgeRunner: JudgeRunner = async ({ job, candidates }) => {
  const sessionId = crypto.randomUUID();
  await registerHeadlessSession(sessionId); // exclude before spawn — robust against a crash mid-run
  const outPath = join(cacheDir(), `judge-out-${sessionId}.json`);
  const prompt = buildJudgePrompt({
    transcriptPath: job.transcript_path,
    candidates,
    outPath,
  });
  const proc = Bun.spawn(judgeArgv(prompt, sessionId), {
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
    throw new Error(`claude -p judge exited ${code}: ${err.trim().slice(0, 200)}`);
  }
  return { sessionId, judgments: parseJudgments(raw, candidates) };
};
