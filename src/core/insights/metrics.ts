import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { readJsonlLinesWithLineNumbers } from "../claude-session.ts";
import { renderWorkspaceKnowledgeSection } from "../knowledge.ts";
import { workspacesRoot } from "../paths.ts";
import { composeSetupParts, extractEmbeddedClaudeMd, fingerprintFromParts } from "./fingerprint.ts";
import { type RuleViolation, type ToolCall, checkRules } from "./rules.ts";

// A per-session metrics record: deterministic, cheap, derived purely from one transcript. Every
// insight area (tokens, instructions, knowledge) reads from this one record, so a session is parsed
// exactly once. The record is cached by `session-id + mtime` in the store; the digest only rolls up.

// Bumping this invalidates every cached metrics record (the store keys on
// `sessionId + mtime + schema`), so a bump forces all records to recompute on next read.
// v4 adds transcript anchors on moment-bearing metrics + the deterministic `candidates` list.
export const METRICS_SCHEMA_VERSION = 4;

/**
 * A stable pointer back into a transcript so a later (qualitative) pass can re-locate the exact
 * moment a number came from. All fields are derived purely from the transcript, so re-extracting
 * the same file yields identical anchors. `turnUuid` is the primary key (it matches the event
 * stream's `turnId`); `toolUseId` and `line` narrow it to a specific tool call / file line.
 */
export interface TranscriptAnchor {
  /** uuid of the transcript turn this moment belongs to (assistant turn for token moments; the
   *  user turn for corrections/commands). The stable cross-recompute key. */
  turnUuid: string | null;
  /** Originating `tool_use_id`, when the moment is a specific tool call or its result. */
  toolUseId: string | null;
  /** 1-based physical line number of the moment's record in the transcript. */
  line: number | null;
}

/** A moment flagged as worth a later qualitative judgment. Deterministic — no LLM involved. */
export type CandidateKind =
  | "large-tool-result"
  | "context-jump"
  | "skill-or-command"
  | "repeated-read"
  | "user-correction"
  | "rule-violation";

export interface Candidate {
  kind: CandidateKind;
  /** Where in the transcript this moment lives. */
  anchor: TranscriptAnchor;
  /** Kind-appropriate size: approx tokens (token kinds) or a count (count kinds). Sorts the list. */
  magnitude: number;
  /** One-line, factual description of the moment (no judgment — that is a later phase). */
  summary: string;
}

export interface ToolBucket {
  tool: string;
  /** Number of tool results from this tool. */
  count: number;
  /** Total characters of result payload. */
  chars: number;
  /** Approximate tokens (chars / 4). */
  approxTokens: number;
}

export interface LargeToolResult {
  tool: string;
  /** The result's target (file path, command, pattern), when known. */
  target: string | null;
  chars: number;
  approxTokens: number;
  /** Where this result sits in the transcript (issuing turn uuid, tool_use_id, line). */
  anchor: TranscriptAnchor;
}

export interface SlashCommandUse {
  name: string;
  count: number;
}

/** One assistant turn on the context-growth curve, with what drove the jump since the last turn. */
export interface ContextPoint {
  /** Assistant-turn index (1-based) across turns that carried token usage. */
  turn: number;
  /** Context size going into this turn: input + cache_read + cache_creation. */
  context: number;
  /** Output tokens produced by this turn. */
  output: number;
  /** Growth vs. the previous point (the size of this jump). */
  delta: number;
  /** Tool results that landed since the previous point — the drivers of this jump, largest first. */
  drivers: { tool: string; approxTokens: number }[];
  /** The assistant turn whose usage produced this point. */
  anchor: TranscriptAnchor;
}

export interface RepeatedRead {
  path: string;
  count: number;
}

export interface SessionMetrics {
  schema: number;
  sessionId: string;
  workspace: string | null;
  repos: string[];
  version: string | null;
  setupFingerprint: string;
  mtimeMs: number;
  userTurns: number;
  assistantTurns: number;

  tokens: {
    /** Max input+cache_read+cache_creation observed across assistant turns. */
    peakContext: number;
    /** The last assistant turn's input+cache_read+cache_creation. */
    finalContext: number;
    /** Best-effort model context window (no field in transcript; inferred from model). */
    contextWindowSize: number;
    totalOutput: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** cache_read / (cache_read + cache_creation + input). */
    cacheHitRatio: number;
    compactionEvents: number;
    /** Tool-result payload sizes bucketed by tool name (what eats the window). */
    toolBuckets: ToolBucket[];
    /** The single largest tool results across the session. */
    topToolResults: LargeToolResult[];
    /** Per-turn context-window trajectory: how it grew, when, and what drove each jump. */
    contextCurve: ContextPoint[];
    /** Static per-session overhead servant imposes (CLAUDE.md + commands + knowledge section). */
    instructionFootprintTokens: number;
  };

  instructions: {
    slashCommands: SlashCommandUse[];
    ruleViolations: RuleViolation[];
    /** tool_result blocks flagged is_error. */
    errorToolResults: number;
    /** Subset of errors that look like permission denials. */
    permissionDenials: number;
    /** User turns shortly after an assistant action that read as a correction/redirect. */
    userCorrections: number;
    /** Files read more than once (instruction/context not retained). */
    repeatedReads: RepeatedRead[];
  };

  knowledge: {
    /** `/servant:recall` markers + `servant recall` Bash calls. */
    recallInvocations: number;
    /** Knowledge note files (knowledge/**\/*.md) opened with Read. */
    knowledgeReads: string[];
    /** Recalls that were followed by a knowledge-note Read (result actually consumed). */
    recallFollowedByRead: number;
  };

  /**
   * A deterministic, bounded worklist of moments worth a later qualitative judgment. Each carries
   * a transcript anchor so a downstream pass can read only the relevant span. Ordered by magnitude
   * (largest first) and capped per session (see `maxCandidates`).
   */
  candidates: Candidate[];
}

const TOP_TOOL_RESULTS = 5;
const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const ONE_MILLION_WINDOW = 1_000_000;

// --- candidate flagging (deterministic heuristics; thresholds tunable) ---
/** Default cap on candidates per session (largest-magnitude first). Configurable per call. */
const DEFAULT_MAX_CANDIDATES = 24;
/** A single tool result at/above this many approx tokens is worth a "justified or wasted?" look. */
const LARGE_RESULT_CANDIDATE_TOKENS = 1500;
/** A turn whose context grew by at least this many tokens is worth a "was it worth it?" look. */
const CONTEXT_JUMP_CANDIDATE_TOKENS = 8000;

const EMPTY_ANCHOR: TranscriptAnchor = { turnUuid: null, toolUseId: null, line: null };

const approxTokens = (chars: number): number => Math.round(chars / APPROX_CHARS_PER_TOKEN);

/** Best-effort context window for a model id (no `context_window_size` field in transcripts). */
function contextWindowFor(model: string | null): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  if (/\[1m\]|-1m\b|1m\b/i.test(model)) return ONE_MILLION_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}

function workspaceNameFromCwd(cwd: string): string | null {
  const rel = relative(resolve(workspacesRoot()), resolve(cwd));
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  const first = rel.split(sep)[0];
  return first || null;
}

/** The repo worktree name (`<repo>__<branch>`) a path sits in, if any. */
function repoFromCwd(workspace: string | null, cwd: string): string | null {
  if (!workspace) return null;
  const wsRoot = resolve(workspacesRoot(), workspace);
  const rel = relative(wsRoot, resolve(cwd));
  const parts = rel.split(sep);
  const idx = parts.indexOf("repos");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1] ?? null;
  return null;
}

// --- content helpers ---

interface AnyRecord {
  type?: string;
  uuid?: string;
  cwd?: string | null;
  version?: string;
  subtype?: string;
  isCompactSummary?: boolean;
  toolUseResult?: unknown;
  message?: { role?: string; model?: string; usage?: TokenUsage; content?: unknown };
}

interface TokenUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

const SLASH_CMD_RE = /<command-name>\s*([^<\s]+)/g;
const KNOWLEDGE_PATH_RE = /(^|\/)knowledge\/.*\.md$/i;
const CORRECTION_RE =
  /^\s*(no\b|nope\b|don'?t\b|do not\b|stop\b|actually\b|wait\b|that'?s (wrong|not)\b|instead\b|revert\b|undo\b|not (what|quite)\b)/i;
const PERMISSION_RE =
  /permission|denied|not allowed|requested permissions|user (rejected|declined)/i;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Length of a tool_result block's payload (string content or stringified array). */
function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const item of content) {
      if (item && typeof item === "object") {
        const t = item as { text?: unknown };
        n += asString(t.text).length;
      }
    }
    return n;
  }
  return 0;
}

function resultIsError(block: { is_error?: unknown; content?: unknown }): boolean {
  if (block.is_error === true) return true;
  const content = block.content;
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return /^Error:|tool ran without|is_error/i.test(text) && /error/i.test(text);
}

/** Extract the human target of a tool call for the "largest results" list. */
function targetOf(tool: string, input: Record<string, unknown>): string | null {
  if (tool === "Bash") return asString(input.command).slice(0, 80) || null;
  if (tool === "Grep") return asString(input.pattern) || null;
  const p = input.file_path ?? input.path ?? input.notebook_path;
  return typeof p === "string" ? p : null;
}

/**
 * Parse one transcript into a deterministic metrics record. Single pass over records, then derived
 * fields (fingerprint, rule checks) computed at the end.
 */
export async function extractSessionMetrics(
  jsonlPath: string,
  opts: { maxCandidates?: number } = {},
): Promise<SessionMetrics> {
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const sessionId = jsonlPath.replace(/^.*\//, "").replace(/\.jsonl$/, "");

  let launchCwd = "";
  let version: string | null = null;
  let model: string | null = null;
  let userTurns = 0;
  let assistantTurns = 0;

  let peakContext = 0;
  let finalContext = 0;
  let totalOutput = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let compactionEvents = 0;

  const toolUseName = new Map<string, string>(); // tool_use_id -> tool name
  const toolUseInput = new Map<string, Record<string, unknown>>();
  const toolUseTurnUuid = new Map<string, string>(); // tool_use_id -> issuing assistant turn uuid
  const toolCalls: ToolCall[] = [];
  const bucketChars = new Map<string, { count: number; chars: number }>();
  const largeResults: LargeToolResult[] = [];

  // Moment lists for candidate flagging — collected with anchors during the single pass.
  const commandUses: { name: string; anchor: TranscriptAnchor }[] = [];
  const corrections: { summary: string; anchor: TranscriptAnchor }[] = [];
  const readAnchors = new Map<string, TranscriptAnchor>(); // path -> first read's anchor

  // Context-growth curve: one point per assistant turn that carried usage, with the tool results
  // that landed since the previous such turn (those are what the next turn's context absorbed).
  const contextCurve: ContextPoint[] = [];
  const pendingDrivers = new Map<string, number>();
  let prevContext = 0;
  let curveTurn = 0;

  const slashCounts = new Map<string, number>();
  let errorToolResults = 0;
  let permissionDenials = 0;
  let userCorrections = 0;
  const readCounts = new Map<string, number>();

  let recallInvocations = 0;
  const knowledgeReads = new Set<string>();
  let recallFollowedByRead = 0;
  let pendingRecall = false; // a recall awaiting a knowledge Read

  const reposSeen = new Set<string>();
  const allRecords: AnyRecord[] = [];
  let lastTurnWasAssistantAction = false;

  for await (const { record, line: lineNo } of readJsonlLinesWithLineNumbers(jsonlPath)) {
    const rec = record as AnyRecord;
    allRecords.push(rec);
    const recUuid = typeof rec.uuid === "string" ? rec.uuid : null;

    if (typeof rec.cwd === "string" && rec.cwd.length > 0 && !launchCwd) {
      launchCwd = rec.cwd;
    }
    if (!version && typeof rec.version === "string") version = rec.version;

    if (
      rec.isCompactSummary === true ||
      (rec.type === "system" && /compact/i.test(rec.subtype ?? ""))
    ) {
      compactionEvents += 1;
    }

    const role = rec.message?.role ?? rec.type;
    const content = rec.message?.content;

    if (role === "assistant") {
      if (!model && typeof rec.message?.model === "string") model = rec.message.model;
      const usage = rec.message?.usage;
      if (usage) {
        const ctx =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        if (ctx > peakContext) peakContext = ctx;
        if (ctx > 0) finalContext = ctx;
        totalOutput += usage.output_tokens ?? 0;
        inputTokens += usage.input_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        if (ctx > 0) {
          curveTurn += 1;
          const drivers = [...pendingDrivers.entries()]
            .map(([tool, t]) => ({ tool, approxTokens: t }))
            .toSorted((a, b) => b.approxTokens - a.approxTokens);
          contextCurve.push({
            turn: curveTurn,
            context: ctx,
            output: usage.output_tokens ?? 0,
            delta: ctx - prevContext,
            drivers,
            anchor: { turnUuid: recUuid, toolUseId: null, line: lineNo },
          });
          prevContext = ctx;
          pendingDrivers.clear();
        }
      }
      let sawText = false;
      let sawAction = false;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== "object") continue;
          const block = item as {
            type?: string;
            text?: unknown;
            id?: string;
            name?: string;
            input?: unknown;
          };
          if (block.type === "text" && asString(block.text).trim()) sawText = true;
          if (block.type === "tool_use" && typeof block.name === "string") {
            sawAction = true;
            const input = (block.input ?? {}) as Record<string, unknown>;
            const callAnchor: TranscriptAnchor = {
              turnUuid: recUuid,
              toolUseId: block.id ?? null,
              line: lineNo,
            };
            if (block.id) {
              toolUseName.set(block.id, block.name);
              toolUseInput.set(block.id, input);
              if (recUuid) toolUseTurnUuid.set(block.id, recUuid);
            }
            toolCalls.push({ tool: block.name, input, anchor: callAnchor });
            if (block.name === "Read") {
              const p = asString(input.file_path ?? input.path);
              if (p) {
                readCounts.set(p, (readCounts.get(p) ?? 0) + 1);
                if (!readAnchors.has(p)) readAnchors.set(p, callAnchor);
              }
            }
            // A skill invoked via the Skill tool is a "skill-or-command" moment (its slash-command
            // sibling is caught in the user-record branch below).
            if (block.name === "Skill") {
              const skill = asString(input.skill ?? input.command) || "Skill";
              commandUses.push({ name: skill, anchor: callAnchor });
            }
            if (block.name === "Bash" && /\bservant recall\b/.test(asString(input.command))) {
              recallInvocations += 1;
              pendingRecall = true;
            }
          }
        }
      }
      if (sawText) assistantTurns += 1;
      lastTurnWasAssistantAction = sawAction || sawText;
    } else if (role === "user") {
      // Tool results live in user records as an array of tool_result blocks.
      let toolResultOnly = false;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== "object") continue;
          const block = item as {
            type?: string;
            tool_use_id?: string;
            is_error?: unknown;
            content?: unknown;
          };
          if (block.type !== "tool_result") continue;
          toolResultOnly = true;
          const tool = (block.tool_use_id && toolUseName.get(block.tool_use_id)) || "unknown";
          const chars = resultChars(block.content);
          const b = bucketChars.get(tool) ?? { count: 0, chars: 0 };
          b.count += 1;
          b.chars += chars;
          bucketChars.set(tool, b);
          // Stage this result as a driver of the next assistant turn's context jump.
          pendingDrivers.set(tool, (pendingDrivers.get(tool) ?? 0) + approxTokens(chars));
          const input = (block.tool_use_id && toolUseInput.get(block.tool_use_id)) || {};
          largeResults.push({
            tool,
            target: targetOf(tool, input),
            chars,
            approxTokens: approxTokens(chars),
            anchor: {
              turnUuid: (block.tool_use_id && toolUseTurnUuid.get(block.tool_use_id)) || null,
              toolUseId: block.tool_use_id ?? null,
              line: lineNo,
            },
          });
          if (resultIsError(block)) {
            errorToolResults += 1;
            const text =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content ?? "");
            if (PERMISSION_RE.test(text)) permissionDenials += 1;
          }
          // A recall is "consumed" if a knowledge note is Read after it.
          if (tool === "Read") {
            const p = asString(input.file_path ?? input.path);
            if (p && KNOWLEDGE_PATH_RE.test(p)) {
              knowledgeReads.add(p);
              if (pendingRecall) {
                recallFollowedByRead += 1;
                pendingRecall = false;
              }
            }
          }
        }
      }
      const text = arrayOrStringText(content);
      if (text !== null && !toolResultOnly) {
        // Slash-command markers (may carry no separate text turn).
        let m: RegExpExecArray | null;
        SLASH_CMD_RE.lastIndex = 0;
        let isCommandTurn = false;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
        while ((m = SLASH_CMD_RE.exec(text)) !== null) {
          const name = m[1] ?? "";
          if (!name) continue;
          isCommandTurn = true;
          slashCounts.set(name, (slashCounts.get(name) ?? 0) + 1);
          commandUses.push({
            name,
            anchor: { turnUuid: recUuid, toolUseId: null, line: lineNo },
          });
          if (/\/servant:recall\b/.test(name) || name === "/recall") {
            recallInvocations += 1;
            pendingRecall = true;
          }
        }
        if (!isCommandTurn) {
          userTurns += 1;
          if (lastTurnWasAssistantAction && CORRECTION_RE.test(text)) {
            userCorrections += 1;
            corrections.push({
              summary: `user correction: "${oneLine(text)}"`,
              anchor: { turnUuid: recUuid, toolUseId: null, line: lineNo },
            });
          }
        }
      }
    }
  }

  const workspace = launchCwd ? workspaceNameFromCwd(launchCwd) : null;
  for (const rec of allRecords) {
    if (typeof rec.cwd === "string") {
      const repo = repoFromCwd(workspace, rec.cwd);
      if (repo) reposSeen.add(repo);
    }
  }
  // Also pick up repos from Write/Edit/Read targets inside a worktree.
  for (const call of toolCalls) {
    const p = asString(call.input.file_path ?? call.input.path);
    const repo = p ? repoFromCwd(workspace, p) : null;
    if (repo) reposSeen.add(repo);
  }
  const repos = [...reposSeen].toSorted();

  const toolBuckets: ToolBucket[] = [...bucketChars.entries()]
    .map(([tool, v]) => ({
      tool,
      count: v.count,
      chars: v.chars,
      approxTokens: approxTokens(v.chars),
    }))
    .toSorted((a, b) => b.chars - a.chars);

  const topToolResults = largeResults
    .toSorted((a, b) => b.chars - a.chars)
    .slice(0, TOP_TOOL_RESULTS);

  const repeatedReads: RepeatedRead[] = [...readCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([path, count]) => ({ path, count }))
    .toSorted((a, b) => b.count - a.count);

  const slashCommands: SlashCommandUse[] = [...slashCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const ruleViolations = checkRules({ toolCalls, launchCwd });

  const candidates = buildCandidates(
    {
      largeResults,
      contextCurve,
      commandUses,
      repeatedReads,
      readAnchors,
      corrections,
      ruleViolations,
    },
    maxCandidates,
  );

  const embeddedClaudeMd = extractEmbeddedClaudeMd(allRecords);
  const composed = await composeSetupParts();
  const claudeMd = embeddedClaudeMd ?? composed.claudeMd;
  const fingerprint = fingerprintFromParts({
    version,
    claudeMd,
    commands: composed.commands,
    knowledgeSection: composed.knowledgeSection,
  });
  // Footprint is the *actual* static per-session overhead: CLAUDE.md + command bodies + the real
  // inlined knowledge section for this session's repos (which the fingerprint deliberately omits).
  let knowledgeSectionChars = 0;
  try {
    knowledgeSectionChars = (await renderWorkspaceKnowledgeSection(repos)).length;
  } catch {
    // knowledge store may not exist yet
  }
  const footprintChars = claudeMd.length + composed.commands.length + knowledgeSectionChars;

  const cacheDenom = cacheReadTokens + cacheCreationTokens + inputTokens;
  const s = await stat(jsonlPath);

  return {
    schema: METRICS_SCHEMA_VERSION,
    sessionId,
    workspace,
    repos,
    version,
    setupFingerprint: fingerprint,
    mtimeMs: s.mtimeMs,
    userTurns,
    assistantTurns,
    tokens: {
      peakContext,
      finalContext,
      contextWindowSize: contextWindowFor(model),
      totalOutput,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheHitRatio: cacheDenom > 0 ? cacheReadTokens / cacheDenom : 0,
      compactionEvents,
      toolBuckets,
      topToolResults,
      contextCurve,
      instructionFootprintTokens: approxTokens(footprintChars),
    },
    instructions: {
      slashCommands,
      ruleViolations,
      errorToolResults,
      permissionDenials,
      userCorrections,
      repeatedReads,
    },
    knowledge: {
      recallInvocations,
      knowledgeReads: [...knowledgeReads].toSorted(),
      recallFollowedByRead,
    },
    candidates,
  };
}

/** Collapse a possibly-multiline string into a short, single-line factual snippet. */
function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface CandidateInputs {
  largeResults: LargeToolResult[];
  contextCurve: ContextPoint[];
  commandUses: { name: string; anchor: TranscriptAnchor }[];
  repeatedReads: RepeatedRead[];
  readAnchors: Map<string, TranscriptAnchor>;
  corrections: { summary: string; anchor: TranscriptAnchor }[];
  ruleViolations: RuleViolation[];
}

/**
 * Turn the moment lists into a single deterministic, bounded candidate worklist. Every kind is
 * gathered, then the whole set is ordered largest-magnitude-first (with stable tiebreakers so the
 * order never depends on insertion or object identity) and truncated to `maxCandidates`.
 */
function buildCandidates(inp: CandidateInputs, maxCandidates: number): Candidate[] {
  const out: Candidate[] = [];

  for (const r of inp.largeResults) {
    if (r.approxTokens < LARGE_RESULT_CANDIDATE_TOKENS) continue;
    out.push({
      kind: "large-tool-result",
      anchor: r.anchor,
      magnitude: r.approxTokens,
      summary: `${r.tool} result ~${r.approxTokens} tok${r.target ? ` (${oneLine(r.target, 50)})` : ""}`,
    });
  }

  for (const p of inp.contextCurve) {
    if (p.delta < CONTEXT_JUMP_CANDIDATE_TOKENS) continue;
    const driver = p.drivers[0];
    out.push({
      kind: "context-jump",
      anchor: p.anchor,
      magnitude: p.delta,
      summary: `turn ${p.turn} context +~${p.delta} tok${driver ? ` (driven by ${driver.tool})` : ""}`,
    });
  }

  for (const c of inp.commandUses) {
    out.push({
      kind: "skill-or-command",
      anchor: c.anchor,
      magnitude: 1,
      summary: `invoked ${c.name}`,
    });
  }

  for (const rr of inp.repeatedReads) {
    out.push({
      kind: "repeated-read",
      anchor: inp.readAnchors.get(rr.path) ?? EMPTY_ANCHOR,
      magnitude: rr.count,
      summary: `read ${oneLine(rr.path, 50)} ×${rr.count}`,
    });
  }

  for (const c of inp.corrections) {
    out.push({ kind: "user-correction", anchor: c.anchor, magnitude: 1, summary: c.summary });
  }

  for (const v of inp.ruleViolations) {
    out.push({
      kind: "rule-violation",
      anchor: v.anchor ?? EMPTY_ANCHOR,
      magnitude: 1,
      summary: `rule ${v.rule}: ${oneLine(v.detail, 50)}`,
    });
  }

  out.sort(
    (a, b) =>
      b.magnitude - a.magnitude ||
      a.kind.localeCompare(b.kind) ||
      (a.anchor.line ?? 0) - (b.anchor.line ?? 0) ||
      a.summary.localeCompare(b.summary),
  );
  return out.slice(0, maxCandidates);
}

function arrayOrStringText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const t = item as { type?: string; text?: unknown };
      if (t.type === "text" && typeof t.text === "string") parts.push(t.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
