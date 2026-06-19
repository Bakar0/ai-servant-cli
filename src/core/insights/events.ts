import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { insightsEventLogPath, workspacesRoot } from "../paths.ts";
import { detectWorkspaceNameFromCwd } from "../workspace.ts";

// Live, push-based telemetry — the OTel half of insights. Claude Code hooks pipe their stdin
// payload into `servant record`, which lands here. Each fire appends one or more events to a
// per-session JSONL log. Token/context numbers are not in any hook payload, so we enrich every
// event by tail-reading the transcript (whose path the hook hands us) for the latest assistant
// turn's `usage` block. Empirically (see the flush-timing probe): at PostToolUse the issuing
// assistant turn is on disk, but at Stop the *final* turn's usage lags one fire — so turn
// emission is idempotent (dedup by assistant uuid) and SessionEnd does the authoritative sweep.

export const EVENTS_SCHEMA_VERSION = 1;

// Bound the per-fire transcript read: hooks fire on every tool call, so we never read the whole
// file. The window comfortably holds several recent turns; anything older was already captured on
// an earlier fire (dedup keeps it idempotent), and the batch reconciler is the full-file safety net.
const TAIL_BYTES = 256 * 1024;

export type EventType =
  | "session_start"
  | "compaction_boundary"
  | "prompt"
  | "tool_start"
  | "tool_end"
  | "compact"
  | "turn_complete"
  | "session_end";

/** Per-turn token state, normalized from a transcript `usage` block. */
export interface UsageSnapshot {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
  cacheCreation5m: number;
  output: number;
  /** input + cacheRead + cacheCreation — the context size going into the turn. */
  context: number;
  serviceTier: string | null;
  webSearch: number;
  webFetch: number;
}

export interface InsightEvent {
  v: number;
  ts: string;
  session: string;
  workspace: string | null;
  event: EventType;
  /** uuid of the assistant turn this event correlates to (the last one on disk at fire time). */
  turnId: string | null;
  ctx: UsageSnapshot | null;
  // event-specific fields (present only where meaningful)
  source?: string; // session_start
  model?: string; // session_start
  reason?: string; // session_end
  trigger?: string; // compact (manual | auto)
  tool?: string; // tool_start | tool_end
  target?: string | null; // tool_start | tool_end
  resultChars?: number; // tool_end
  isError?: boolean; // tool_end
  promptChars?: number; // prompt
  slashCommand?: string | null; // prompt
  effort?: string; // turn_complete
  /**
   * True when this event was backfilled by the batch reconciler rather than emitted live. Lets the
   * dashboard/LLM layer tell live telemetry from reconstructed gaps. Distinct from `source` (which
   * already carries the SessionStart origin: startup | resume | compact | …).
   */
  reconciled?: boolean;
}

// --- transcript shapes (only the fields we read) ---

export interface RawUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  service_tier?: string;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
}

interface RawLine {
  type?: string;
  uuid?: string;
  message?: { role?: string; usage?: RawUsage };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Normalize a transcript `usage` block into a flat snapshot. */
export function parseUsage(u: RawUsage | undefined): UsageSnapshot | null {
  if (!u) return null;
  const input = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreation = num(u.cache_creation_input_tokens);
  return {
    input,
    cacheRead,
    cacheCreation,
    cacheCreation1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
    cacheCreation5m: num(u.cache_creation?.ephemeral_5m_input_tokens),
    output: num(u.output_tokens),
    context: input + cacheRead + cacheCreation,
    serviceTier: u.service_tier ?? null,
    webSearch: num(u.server_tool_use?.web_search_requests),
    webFetch: num(u.server_tool_use?.web_fetch_requests),
  };
}

/** Parse a block of JSONL text into the transcript lines we understand, skipping junk. */
export function parseTranscriptLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RawLine);
    } catch {
      // a partial first line from a byte-bounded tail read, or a malformed entry — skip it
    }
  }
  return out;
}

/** Read the trailing window of the transcript and parse it (dropping the partial leading line). */
export async function readTranscriptTail(path: string): Promise<RawLine[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const size = file.size;
  const slice = size > TAIL_BYTES ? file.slice(size - TAIL_BYTES) : file;
  return parseTranscriptLines(await slice.text());
}

interface AssistantTurn {
  uuid: string;
  usage: UsageSnapshot;
}

const usageSig = (u: UsageSnapshot): string =>
  `${u.input}:${u.cacheRead}:${u.cacheCreation}:${u.output}`;

/**
 * Distinct assistant turns carrying a usage block, in transcript order. One logical turn is written
 * as several lines (thinking, then tool_use) with *different* uuids but the *same* usage block (it's
 * the one API response repeated), so a naive per-line or per-uuid pass would count a turn's output
 * two or three times. We collapse a contiguous run of assistant lines sharing a usage signature into
 * one turn and keep the FIRST uuid as its id — that id stays stable as the run's later lines flush
 * in across hook fires, which is what keeps cross-fire dedup idempotent. A non-assistant line (a
 * tool_result) resets the run, so two real turns that happen to share a signature aren't merged.
 */
export function assistantTurns(lines: RawLine[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  let runSig: string | null = null;
  for (const l of lines) {
    const usage = l.message?.role === "assistant" && l.uuid ? parseUsage(l.message.usage) : null;
    if (!usage || !l.uuid) {
      runSig = null; // non-assistant line ends the current run
      continue;
    }
    const sig = usageSig(usage);
    if (sig === runSig) continue; // continuation line of the same logical turn
    runSig = sig;
    turns.push({ uuid: l.uuid, usage });
  }
  return turns;
}

/** The freshest assistant turn on disk — the correlation target for an enriched event. */
export function lastAssistantTurn(lines: RawLine[]): AssistantTurn | null {
  const turns = assistantTurns(lines);
  return turns.length ? (turns[turns.length - 1] ?? null) : null;
}

// --- event log IO ---

export async function appendEvents(sessionId: string, events: InsightEvent[]): Promise<void> {
  if (events.length === 0) return;
  const path = insightsEventLogPath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Parse a session's event log into events, skipping junk. Returns [] when no log exists yet. */
export async function readEventLog(sessionId: string): Promise<InsightEvent[]> {
  let text: string;
  try {
    text = await readFile(insightsEventLogPath(sessionId), "utf8");
  } catch {
    return []; // no log yet
  }
  const out: InsightEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as InsightEvent);
    } catch {
      // skip malformed entry
    }
  }
  return out;
}

/** uuids already emitted as turn_complete events — the dedup key that makes turn sync idempotent. */
async function emittedTurnIds(sessionId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const e of await readEventLog(sessionId)) {
    if (e.event === "turn_complete" && e.turnId) ids.add(e.turnId);
  }
  return ids;
}

// --- hook payload routing ---

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string; // SessionStart
  model?: string; // SessionStart
  reason?: string; // SessionEnd
  trigger?: string; // PreCompact
  prompt?: string; // UserPromptSubmit
  tool_name?: string; // Pre/PostToolUse
  tool_input?: Record<string, unknown>; // Pre/PostToolUse
  tool_output?: unknown; // PostToolUse
  tool_response?: unknown; // PostToolUse (alias seen in docs)
  effort?: string; // Stop
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Resolve symlinks (best-effort) so realpath'd hook cwds match the servant root. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "");
  }
}

/** Human target of a tool call for the timeline (file / command / pattern). */
function toolTarget(tool: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  if (tool === "Bash") return asString(input.command).slice(0, 80) || null;
  if (tool === "Grep") return asString(input.pattern) || null;
  const p = input.file_path ?? input.path ?? input.notebook_path;
  return typeof p === "string" ? p : null;
}

/** Character length of a tool result payload (string or array-of-text-blocks). */
function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const item of content) {
      if (item && typeof item === "object") n += asString((item as { text?: unknown }).text).length;
    }
    return n;
  }
  return 0;
}

const SLASH_RE = /^\s*(\/[A-Za-z0-9:_-]+)/;

function slashCommandOf(prompt: string): string | null {
  return SLASH_RE.exec(prompt)?.[1] ?? null;
}

/**
 * Record a hook fire. Reads the hook payload (already parsed), enriches it with the latest
 * transcript usage, and appends the resulting event(s). Never throws and never blocks the
 * session — callers (the `record` command) swallow everything and exit 0.
 */
export async function recordHookEvent(payload: HookPayload): Promise<void> {
  // The servant's own headless sessions (knowledge extraction, future insights runs) are not user
  // activity — don't measure them. Their subprocesses inherit these env markers.
  if (process.env.SERVANT_EXTRACTION || process.env.SERVANT_INSIGHTS) return;

  const cwd = payload.cwd ?? "";
  const sessionId = payload.session_id ?? "";
  const transcriptPath = payload.transcript_path ?? "";
  if (!sessionId || !cwd) return;
  // Resolve symlinks on both sides before matching: macOS reports the hook cwd realpath'd
  // (/private/var/...), so a raw compare against the servant root can miss. Mirrors the
  // canonicalization the SessionEnd extraction hook already does.
  const workspace = detectWorkspaceNameFromCwd(canonical(cwd), canonical(workspacesRoot()));
  if (!workspace) return; // not a servant workspace session

  const lines = transcriptPath ? await readTranscriptTail(transcriptPath) : [];
  const last = lastAssistantTurn(lines);
  const ts = new Date().toISOString();

  const base = {
    v: EVENTS_SCHEMA_VERSION,
    ts,
    session: sessionId,
    workspace,
    turnId: last?.uuid ?? null,
    ctx: last?.usage ?? null,
  } as const;

  const hook = payload.hook_event_name ?? "";
  const events: InsightEvent[] = [];

  switch (hook) {
    case "SessionStart":
      events.push({
        ...base,
        event: payload.source === "compact" ? "compaction_boundary" : "session_start",
        source: payload.source,
        model: payload.model,
      });
      break;
    case "UserPromptSubmit": {
      const prompt = asString(payload.prompt);
      events.push({
        ...base,
        event: "prompt",
        promptChars: prompt.length,
        slashCommand: slashCommandOf(prompt),
      });
      break;
    }
    case "PreToolUse": {
      const tool = asString(payload.tool_name);
      events.push({
        ...base,
        event: "tool_start",
        tool,
        target: toolTarget(tool, payload.tool_input),
      });
      break;
    }
    case "PostToolUse": {
      const tool = asString(payload.tool_name);
      const out = payload.tool_output ?? payload.tool_response;
      events.push({
        ...base,
        event: "tool_end",
        tool,
        target: toolTarget(tool, payload.tool_input),
        resultChars: resultChars(out),
        isError:
          typeof out === "object" &&
          out !== null &&
          (out as { is_error?: boolean }).is_error === true,
      });
      break;
    }
    case "PreCompact":
      events.push({ ...base, event: "compact", trigger: payload.trigger });
      break;
    case "Stop":
      events.push(...(await syncTurns(sessionId, lines, base.workspace, payload.effort)));
      break;
    case "SessionEnd":
      events.push(...(await syncTurns(sessionId, lines, base.workspace, undefined)));
      events.push({ ...base, event: "session_end", reason: payload.reason });
      break;
    default:
      return; // unknown hook — nothing to record
  }

  await appendEvents(sessionId, events);
}

/**
 * Emit a `turn_complete` for every assistant turn now on disk that we haven't emitted yet.
 * Idempotent via dedup against the log: because `Stop` lags the final turn by one fire, a turn
 * typically lands on the *next* Stop (or the SessionEnd sweep), and re-reads never double-count.
 */
async function syncTurns(
  sessionId: string,
  lines: RawLine[],
  workspace: string | null,
  effort: string | undefined,
): Promise<InsightEvent[]> {
  const already = await emittedTurnIds(sessionId);
  const ts = new Date().toISOString();
  const fresh: InsightEvent[] = [];
  for (const turn of assistantTurns(lines)) {
    if (already.has(turn.uuid)) continue;
    already.add(turn.uuid);
    fresh.push({
      v: EVENTS_SCHEMA_VERSION,
      ts,
      session: sessionId,
      workspace,
      event: "turn_complete",
      turnId: turn.uuid,
      ctx: turn.usage,
      effort,
    });
  }
  return fresh;
}
