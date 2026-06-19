import { realpathSync } from "node:fs";
import { findSessionJsonl, listWorkspaceSessions } from "../claude-session.ts";
import { workspacesRoot } from "../paths.ts";
import { detectWorkspaceNameFromCwd } from "../workspace.ts";
import {
  EVENTS_SCHEMA_VERSION,
  type InsightEvent,
  type RawUsage,
  type UsageSnapshot,
  appendEvents,
  assistantTurns,
  readEventLog,
} from "./events.ts";

// The batch reconciler — the deterministic safety net behind the lossy live recorder. Hooks can be
// missed or cancelled (a fast process exit kills the in-flight SessionEnd), and sessions created
// before instrumentation have no event log at all. Given a session's *full* transcript (ground
// truth), this makes the event log eventually consistent: it reconstructs the token-bearing and
// structural events the live path would have emitted and appends only the ones the log is missing.
// It reuses the live path's turn-collapsing (`assistantTurns`) and usage parsing (`parseUsage`, via
// `assistantTurns`) verbatim — no fork — so reconciled events share the live schema. It is
// idempotent: every event type gap-fills against what the log already holds, so a second run is a
// no-op. It also doubles as a consistency check: where the live `ctx` disagrees with the transcript
// (including turns the live path captured with no usage at all), it reports the divergence.
//
// v1 scope is deliberately the token-bearing + structural signals — `turn_complete`,
// `compaction_boundary`, `session_end`. Tool/prompt events carry no tokens and the live path covers
// them well, so reconstructing that high-volume timeline is out of scope here.

type AssistantTurn = ReturnType<typeof assistantTurns>[number];

/** A transcript line — superset of the live recorder's `RawLine`, plus the fields we reconcile on. */
interface ReconLine {
  type?: string;
  uuid?: string;
  cwd?: string | null;
  subtype?: string;
  isCompactSummary?: boolean;
  timestamp?: string;
  message?: { role?: string; usage?: RawUsage; model?: string };
}

/** A turn the log and the transcript both name, but whose token numbers disagree. */
export interface UsageDiscrepancy {
  turnId: string;
  field: keyof UsageSnapshot;
  live: number;
  transcript: number;
}

export interface ReconcileResult {
  sessionId: string;
  /** Whether the log already existed (false ⇒ full reconstruction from the transcript). */
  hadLog: boolean;
  /** Total events appended this run. */
  appended: number;
  /** Appended count broken down by event type. */
  byType: Record<string, number>;
  discrepancies: UsageDiscrepancy[];
}

// The numeric usage fields we cross-check live vs. transcript (the token-bearing ones).
const USAGE_FIELDS: (keyof UsageSnapshot)[] = [
  "input",
  "cacheRead",
  "cacheCreation",
  "output",
  "context",
];

function parseFullTranscript(text: string): ReconLine[] {
  const out: ReconLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ReconLine);
    } catch {
      // skip malformed entry
    }
  }
  return out;
}

/** Resolve symlinks (best-effort) so a realpath'd transcript cwd matches the servant root. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "");
  }
}

/** Workspace name for the session, from the transcript's first recorded cwd (matches the live path). */
function workspaceOf(lines: ReconLine[]): string | null {
  const cwd = lines.find((l) => typeof l.cwd === "string" && l.cwd.length > 0)?.cwd;
  if (!cwd) return null;
  return detectWorkspaceNameFromCwd(canonical(cwd), canonical(workspacesRoot()));
}

/**
 * Compaction boundaries in transcript order. One compaction leaves both a `system`
 * `compact_boundary` line and a `user` `isCompactSummary` line, so we count the system lines (the
 * canonical marker) and fall back to summary lines only when no system lines are present.
 */
function compactionBoundaryIndexes(lines: ReconLine[]): number[] {
  const system: number[] = [];
  const summary: number[] = [];
  lines.forEach((l, i) => {
    if (l.type === "system" && /compact/i.test(l.subtype ?? "")) system.push(i);
    else if (l.isCompactSummary === true) summary.push(i);
  });
  return system.length > 0 ? system : summary;
}

/** The freshest assistant turn at or before a line index — the context that event correlates to. */
function turnAtOrBefore(
  turns: AssistantTurn[],
  firstIndexByUuid: Map<string, number>,
  lineIndex: number,
): AssistantTurn | null {
  let best: AssistantTurn | null = null;
  for (const t of turns) {
    const idx = firstIndexByUuid.get(t.uuid) ?? -1;
    if (idx > lineIndex) break; // turns are in transcript order
    best = t;
  }
  return best;
}

/**
 * Reconcile one session's event log against its transcript. Appends only missing events and returns
 * what it did plus any live/transcript disagreements. Idempotent.
 */
export async function reconcileSession(
  transcriptPath: string,
  sessionId: string,
): Promise<ReconcileResult> {
  const text = await Bun.file(transcriptPath).text();
  const lines = parseFullTranscript(text);
  const turns = assistantTurns(lines);
  const workspace = workspaceOf(lines);

  // First line index per uuid: a turn's id is its run's first uuid, and that's where it sits.
  const firstIndexByUuid = new Map<string, number>();
  lines.forEach((l, i) => {
    if (l.uuid && !firstIndexByUuid.has(l.uuid)) firstIndexByUuid.set(l.uuid, i);
  });
  const tsAt = (idx: number): string => lines[idx]?.timestamp ?? new Date().toISOString();

  // What the log already holds, by event type.
  const existing = await readEventLog(sessionId);
  const hadLog = existing.length > 0;
  const loggedTurnIds = new Set<string>();
  const liveCtxByTurn = new Map<string, UsageSnapshot | null>();
  let loggedBoundaries = 0;
  let loggedSessionEnds = 0;
  for (const e of existing) {
    if (e.event === "turn_complete" && e.turnId) {
      loggedTurnIds.add(e.turnId);
      liveCtxByTurn.set(e.turnId, e.ctx);
    } else if (e.event === "compaction_boundary") {
      loggedBoundaries += 1;
    } else if (e.event === "session_end") {
      loggedSessionEnds += 1;
    }
  }

  const base = {
    v: EVENTS_SCHEMA_VERSION,
    session: sessionId,
    workspace,
    reconciled: true as const,
  };
  const candidates: { key: number; event: InsightEvent }[] = [];

  // 1. turn_complete — append every transcript turn the log is missing (dedup by turnId, the live key).
  for (const turn of turns) {
    if (loggedTurnIds.has(turn.uuid)) continue;
    const idx = firstIndexByUuid.get(turn.uuid) ?? 0;
    candidates.push({
      key: idx,
      event: { ...base, ts: tsAt(idx), event: "turn_complete", turnId: turn.uuid, ctx: turn.usage },
    });
  }

  // 2. compaction_boundary — count-based gap fill. The transcript is ground truth for how many
  // compactions happened; emit the trailing ones the log doesn't yet account for.
  const boundaries = compactionBoundaryIndexes(lines);
  const missingBoundaries = Math.max(0, boundaries.length - loggedBoundaries);
  for (const idx of boundaries.slice(boundaries.length - missingBoundaries)) {
    const turn = turnAtOrBefore(turns, firstIndexByUuid, idx);
    candidates.push({
      key: idx,
      event: {
        ...base,
        ts: tsAt(idx),
        event: "compaction_boundary",
        turnId: turn?.uuid ?? null,
        ctx: turn?.usage ?? null,
      },
    });
  }

  // 3. session_end — a session has exactly one; synthesize it only if the log never recorded one
  // (e.g. a fast exit cancelled the SessionEnd hook, or the session predates instrumentation).
  if (loggedSessionEnds === 0 && lines.length > 0) {
    const lastTurn = turns.at(-1) ?? null;
    candidates.push({
      key: Number.MAX_SAFE_INTEGER,
      event: {
        ...base,
        ts: tsAt(lines.length - 1),
        event: "session_end",
        turnId: lastTurn?.uuid ?? null,
        ctx: lastTurn?.usage ?? null,
      },
    });
  }

  candidates.sort((a, b) => a.key - b.key);
  const events = candidates.map((c) => c.event);

  // Consistency check: for turns the log AND the transcript both name, flag token disagreements —
  // including turns the live path captured with null usage (the lagging-Stop case) now that the
  // transcript carries the real numbers.
  const discrepancies: UsageDiscrepancy[] = [];
  for (const turn of turns) {
    if (!loggedTurnIds.has(turn.uuid)) continue;
    const live = liveCtxByTurn.get(turn.uuid) ?? null;
    for (const field of USAGE_FIELDS) {
      const liveVal = live ? (live[field] as number) : 0;
      const transcriptVal = turn.usage[field] as number;
      if (liveVal !== transcriptVal) {
        discrepancies.push({ turnId: turn.uuid, field, live: liveVal, transcript: transcriptVal });
      }
    }
  }

  await appendEvents(sessionId, events);

  const byType: Record<string, number> = {};
  for (const e of events) byType[e.event] = (byType[e.event] ?? 0) + 1;
  return { sessionId, hadLog, appended: events.length, byType, discrepancies };
}

/** Reconcile one session by id (resolves its transcript). Returns null if no transcript is found. */
export async function reconcileSessionById(sessionId: string): Promise<ReconcileResult | null> {
  const jsonlPath = await findSessionJsonl(sessionId);
  if (!jsonlPath) return null;
  return reconcileSession(jsonlPath, sessionId);
}

/** Reconcile every servant session within the mtime window. */
export async function reconcileAllSessions(maxAgeMs: number): Promise<ReconcileResult[]> {
  const sessions = await listWorkspaceSessions({ maxAgeMs });
  const results: ReconcileResult[] = [];
  for (const s of sessions) {
    try {
      results.push(await reconcileSession(s.jsonlPath, s.sessionId));
    } catch {
      // skip sessions we can't read/parse — reconciliation is best-effort maintenance
    }
  }
  return results;
}
