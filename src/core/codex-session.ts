import { stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ClaudeSessionMeta, ListSessionsOpts } from "./claude-session.ts";
import { codexSessionsDir, workspacesRoot } from "./paths.ts";
import type { SessionSource } from "./session-source.ts";
import { assertValidWorkspaceName } from "./workspace.ts";

// Reads Codex CLI rollout logs (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`) and adapts
// them to servant's backend-agnostic SessionSource. Two jobs: (1) discovery + meta for resume/picker,
// and (2) `readRecords`, which re-shapes each rollout line into the *Claude* record model so
// `metrics.ts` parses either backend through one code path.
//
// Every field name below was verified against real rollout files (Codex 0.42–0.77). The parser must
// never throw on malformed/partial data — it degrades to empty/nulls, matching claude-session.ts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same window as claude-session.ts's DEFAULT_MAX_AGE_MS (30 days).
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// --- rollout line shape (verified) ---
// { timestamp, type, payload }
//   session_meta → payload { id, cwd, cli_version, originator, git:{branch,commit_hash}, instructions }
//   turn_context → payload { cwd, model, effort, approval_policy, sandbox_policy, summary }
//   response_item → payload.type:
//     "message"                { role:"user"|"assistant", content:[{type:"input_text"|"output_text", text}] }
//     "function_call"          { name, arguments (JSON string), call_id }
//     "custom_tool_call"       { name, input (string; apply_patch carries raw patch text), call_id }
//     "function_call_output"   { call_id, output (string; shell tools embed JSON {output, metadata.exit_code}) }
//     "custom_tool_call_output"{ call_id, output } — same shape as function_call_output
//     "reasoning" | "ghost_snapshot" — ignored
//   event_msg → payload.type:
//     "token_count"  { info: null | { total_token_usage, last_token_usage, model_context_window }, rate_limits }
//     "agent_message"/"user_message" — duplicates of the response_item messages; used only as meta fallbacks
//     "agent_reasoning" — ignored
interface RolloutLine {
  type?: string;
  payload?: Record<string, unknown>;
}

async function* readRollout(path: string): AsyncGenerator<{ rec: RolloutLine; line: number }> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return; // missing/unreadable file — yield nothing
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) continue;
    try {
      yield { rec: JSON.parse(trimmed) as RolloutLine, line: i + 1 };
    } catch {
      // skip malformed lines (line numbers stay physical, matching readJsonlLinesWithLineNumbers)
    }
  }
}

function validateSessionId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid Codex session id "${id}" (expected UUID).`);
  }
}

/** The trailing UUID of a rollout filename is the session id. */
function sessionIdFromFile(file: string): string {
  const base = file.replace(/^.*\//, "");
  const m = base.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\.jsonl$)/i,
  );
  return m?.[1] ?? "";
}

// Replicated from claude-session.ts (its copy is not exported) so both backends classify workspaces
// identically: launchCwd relative to workspacesRoot(), first path segment, validated as a name.
function workspaceNameFromCwd(cwd: string): string | null {
  const rel = relative(resolve(workspacesRoot()), resolve(cwd));
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  const first = rel.split(sep)[0];
  if (!first) return null;
  try {
    assertValidWorkspaceName(first);
  } catch {
    return null;
  }
  return first;
}

function isEnvironmentContext(text: string): boolean {
  return text.trimStart().startsWith("<environment_context>");
}

/** Text of a Codex message's content array (input_text/output_text/text blocks). */
function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const o = item as { type?: string; text?: unknown };
      if (
        (o.type === "input_text" || o.type === "output_text" || o.type === "text") &&
        typeof o.text === "string"
      ) {
        parts.push(o.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

async function findSessionFile(id: string): Promise<string | null> {
  validateSessionId(id);
  const root = codexSessionsDir();
  const glob = new Bun.Glob(`**/*${id}.jsonl`);
  try {
    for await (const match of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
      return join(root, match);
    }
  } catch {
    // sessions root missing
  }
  return null;
}

async function readLaunchCwd(file: string): Promise<string | null> {
  let firstTurnCwd: string | null = null;
  for await (const { rec } of readRollout(file)) {
    const p = rec.payload ?? {};
    if (rec.type === "session_meta" && typeof p.cwd === "string" && p.cwd.length > 0) {
      return p.cwd; // session_meta is the first line — the authoritative launch cwd
    }
    if (
      rec.type === "turn_context" &&
      typeof p.cwd === "string" &&
      p.cwd.length > 0 &&
      firstTurnCwd === null
    ) {
      firstTurnCwd = p.cwd;
    }
  }
  return firstTurnCwd;
}

async function readSessionMeta(file: string): Promise<ClaudeSessionMeta> {
  const sessionId = sessionIdFromFile(file);

  let sessionCwd: string | null = null;
  let firstTurnCwd: string | null = null;
  let latestCwd: string | null = null;
  let model: string | null = null;

  let firstUser: string | null = null;
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  let userTurns = 0;
  let assistantTurns = 0;

  // event_msg duplicates of the response_item messages — used only when the response_item stream is
  // absent (version tolerance), so older/newer layouts still yield sane first/last/turn counts.
  let evFirstUser: string | null = null;
  let evLastUser: string | null = null;
  let evLastAssistant: string | null = null;
  let evUserTurns = 0;
  let evAssistantTurns = 0;

  for await (const { rec } of readRollout(file)) {
    const p = rec.payload ?? {};
    if (rec.type === "session_meta") {
      if (typeof p.cwd === "string" && p.cwd.length > 0) sessionCwd = p.cwd;
    } else if (rec.type === "turn_context") {
      if (typeof p.cwd === "string" && p.cwd.length > 0) {
        if (firstTurnCwd === null) firstTurnCwd = p.cwd;
        latestCwd = p.cwd;
      }
      if (!model && typeof p.model === "string" && p.model.length > 0) model = p.model;
    } else if (rec.type === "response_item") {
      if (p.type === "message") {
        const text = textFromContent(p.content);
        if (text === null) continue;
        if (p.role === "user" && !isEnvironmentContext(text)) {
          userTurns += 1;
          if (firstUser === null) firstUser = text;
          lastUser = text;
        } else if (p.role === "assistant") {
          assistantTurns += 1;
          lastAssistant = text;
        }
      }
    } else if (rec.type === "event_msg") {
      if (p.type === "user_message" && typeof p.message === "string") {
        if (!isEnvironmentContext(p.message)) {
          evUserTurns += 1;
          if (evFirstUser === null) evFirstUser = p.message;
          evLastUser = p.message;
        }
      } else if (p.type === "agent_message" && typeof p.message === "string") {
        evAssistantTurns += 1;
        evLastAssistant = p.message;
      }
    }
  }

  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    // file vanished between discovery and read
  }

  const launchCwd = sessionCwd ?? firstTurnCwd ?? "";
  return {
    sessionId,
    jsonlPath: file,
    launchCwd,
    latestCwd: latestCwd ?? launchCwd,
    workspaceName: launchCwd ? workspaceNameFromCwd(launchCwd) : null,
    firstUserMessage: firstUser ?? evFirstUser,
    lastUserMessage: lastUser ?? evLastUser,
    lastAssistantMessage: lastAssistant ?? evLastAssistant,
    model,
    userTurns: userTurns > 0 ? userTurns : evUserTurns,
    assistantTurns: assistantTurns > 0 ? assistantTurns : evAssistantTurns,
    mtimeMs,
  };
}

async function listWorkspaceSessions(opts: ListSessionsOpts = {}): Promise<ClaudeSessionMeta[]> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const includeWorktreeSubdirs = opts.includeWorktreeSubdirs ?? true;
  const now = Date.now();
  const wsRoot = workspacesRoot();
  const root = codexSessionsDir();

  // No headless-exclusion filter: servant's own Codex headless runs use `--ephemeral` and are never
  // persisted to the sessions store, so nothing here can be one of servant's own runs.
  const out: ClaudeSessionMeta[] = [];
  const glob = new Bun.Glob("**/rollout-*.jsonl");
  try {
    for await (const match of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
      const path = join(root, match);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(path);
      } catch {
        continue;
      }
      if (now - s.mtimeMs > maxAgeMs) continue;

      let meta: ClaudeSessionMeta;
      try {
        meta = await readSessionMeta(path);
      } catch {
        continue;
      }
      if (!meta.launchCwd) continue;
      if (meta.userTurns === 0) continue;

      if (opts.workspaceName) {
        if (meta.workspaceName !== opts.workspaceName) continue;
      } else if (meta.workspaceName === null) {
        continue;
      }

      if (!includeWorktreeSubdirs) {
        const expected = opts.workspaceName
          ? join(wsRoot, opts.workspaceName)
          : meta.workspaceName
            ? join(wsRoot, meta.workspaceName)
            : null;
        if (expected && resolve(meta.launchCwd) !== resolve(expected)) continue;
      }

      out.push(meta);
    }
  } catch {
    // sessions root missing — return whatever accumulated (empty)
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// --- readRecords: Codex rollout line → Claude record ---

interface ClaudeUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Codex/OpenAI usage → Claude usage. `input_tokens` from OpenAI is the *total* prompt size and is
// INCLUSIVE of cached tokens, whereas Claude's `input_tokens` is the non-cached remainder (context =
// input + cache_read + cache_creation). We therefore subtract cached from input so metrics.ts's
// context arithmetic isn't double-counted. Codex has no separate cache-creation phase → 0.
function mapUsage(u: Record<string, unknown>): ClaudeUsage {
  const input = num(u.input_tokens);
  const cached = num(u.cached_input_tokens);
  return {
    input_tokens: Math.max(0, input - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: num(u.output_tokens),
  };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

/** First file path named by an apply_patch envelope (`*** Update/Add/Delete File: <path>`). */
function patchFilePath(patch: string): string | null {
  const m = patch.match(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)/);
  return m?.[1]?.trim() || null;
}

/**
 * Codex's shell tool passes `command` as an argv array, usually `[shell, "-lc"|"-c", script]`. The
 * script's leading program is what metrics buckets Bash by, so unwrap that shell wrapper to the
 * script; otherwise join the argv. Returns "" when there's no command.
 */
function shellCommandString(args: Record<string, unknown>): string {
  const cmd = args.command;
  if (Array.isArray(cmd)) {
    if (
      cmd.length >= 3 &&
      /(^|\/)(ba|z|)sh$/.test(String(cmd[0])) &&
      /^-[a-z]*c$/.test(String(cmd[1]))
    ) {
      return String(cmd[cmd.length - 1]);
    }
    return cmd.map(String).join(" ");
  }
  return typeof cmd === "string" ? cmd : "";
}

// Codex tool name → Claude tool name, so metrics.ts's buckets/rules (keyed on Claude names) work:
//   shell                          → Bash   (input.command = unwrapped shell script string)
//   apply_patch / patch            → Edit   (input.file_path = patched file, from the patch header)
//   read_file / view / cat / open* → Read   (input.file_path from the tool's path/file arg)
//   anything else                  → kept under its Codex name (metrics degrades gracefully)
// `rawArgs` is the JSON string from function_call.arguments, or the raw string from
// custom_tool_call.input (apply_patch carries raw patch text there, not JSON).
function mapToolCall(
  codexName: string,
  rawArgs: unknown,
): { name: string; input: Record<string, unknown> } {
  if (codexName === "shell") {
    const args = parseArgs(rawArgs);
    const input: Record<string, unknown> = { command: shellCommandString(args) };
    if (typeof args.workdir === "string") input.workdir = args.workdir;
    return { name: "Bash", input };
  }
  if (codexName === "apply_patch" || codexName === "patch") {
    const patch = typeof rawArgs === "string" ? rawArgs : "";
    const fp = patchFilePath(patch);
    return { name: "Edit", input: fp ? { file_path: fp } : {} };
  }
  const args = parseArgs(rawArgs);
  if (/read|view|cat|open/i.test(codexName)) {
    const fp = args.file_path ?? args.path;
    if (typeof fp === "string") return { name: "Read", input: { file_path: fp } };
  }
  return { name: codexName, input: args };
}

/**
 * A tool result's text + error flag. Shell-family outputs are a JSON string carrying the real text
 * under `output` and an exit code under `metadata.exit_code` (non-zero ⇒ error); simpler tools emit
 * a plain string.
 */
function parseToolOutput(output: unknown): { content: string; isError: boolean } {
  const fromObject = (o: Record<string, unknown>, fallback: string) => {
    const txt =
      typeof o.output === "string"
        ? o.output
        : typeof o.content === "string"
          ? o.content
          : fallback;
    const meta = o.metadata as { exit_code?: unknown } | undefined;
    const ec = meta?.exit_code;
    return { content: txt, isError: typeof ec === "number" && ec !== 0 };
  };
  if (typeof output === "string") {
    try {
      const p = JSON.parse(output);
      if (p && typeof p === "object") return fromObject(p as Record<string, unknown>, output);
    } catch {
      // not JSON — a plain output string
    }
    return { content: output, isError: false };
  }
  if (output && typeof output === "object") {
    return fromObject(output as Record<string, unknown>, JSON.stringify(output));
  }
  // Remaining case: a non-string, non-object primitive (number/boolean) or null/undefined.
  return { content: output == null ? "" : JSON.stringify(output), isError: false };
}

/**
 * Yield the rollout as Claude-shaped records with their 1-based physical line number. Emission rules
 * (see the mapping tables above):
 *  - session_meta/turn_context carry no content — they update `version`/`cwd`/`model` state only.
 *  - a `token_count` event's per-turn usage (`last_token_usage`, else `total_token_usage`) is held in
 *    `pendingUsage` and attached to the *next* assistant record, then cleared. Codex emits usage as
 *    its own event *before* the assistant item, and re-emits the previous total at turn start; the
 *    turn's real count always overwrites that echo before an assistant record consumes it, so each
 *    assistant/tool turn receives exactly its own usage. (Approximation: `last_token_usage` is the
 *    per-request snapshot — the right source for both context size and per-turn output, since
 *    `total_token_usage` is cumulative in newer versions and would inflate summed output.)
 *  - response_item message(assistant) → assistant record with a text block (+ usage).
 *  - response_item message(user, non-env) → user record with a text block.
 *  - function_call / custom_tool_call → assistant record carrying a single tool_use block.
 *  - function_call_output / custom_tool_call_output → user record with a tool_result block.
 *  - a compaction line (type or payload.type matching /compact/) → a system/compact record.
 */
async function* readRecords(file: string): AsyncGenerator<{ record: unknown; line: number }> {
  let version: string | null = null;
  let cwd = "";
  let model: string | null = null;
  let pendingUsage: ClaudeUsage | null = null;

  const base = (line: number) => ({
    uuid: `codex-${line}`,
    cwd,
    ...(version ? { version } : {}),
  });

  for await (const { rec, line } of readRollout(file)) {
    const p = rec.payload ?? {};

    if (rec.type === "session_meta") {
      if (typeof p.cli_version === "string") version = p.cli_version;
      if (typeof p.cwd === "string" && p.cwd.length > 0) cwd = p.cwd;
      continue;
    }
    if (rec.type === "turn_context") {
      if (typeof p.cwd === "string" && p.cwd.length > 0) cwd = p.cwd;
      if (typeof p.model === "string" && p.model.length > 0) model = p.model;
      continue;
    }

    // Compaction can appear at the top level or inside payload depending on version.
    const payloadType = typeof p.type === "string" ? p.type : "";
    if (/compact/i.test(rec.type ?? "") || /compact/i.test(payloadType)) {
      yield {
        record: { type: "system", subtype: "compact", isCompactSummary: true, ...base(line) },
        line,
      };
      continue;
    }

    if (rec.type === "event_msg") {
      if (p.type === "token_count") {
        const info = p.info;
        if (info && typeof info === "object") {
          const i = info as Record<string, unknown>;
          const u = (i.last_token_usage ?? i.total_token_usage) as
            | Record<string, unknown>
            | undefined;
          if (u && typeof u === "object") pendingUsage = mapUsage(u);
        }
      }
      continue; // agent_message/user_message are duplicates of the response_item stream
    }

    if (rec.type !== "response_item") continue;

    if (p.type === "message") {
      const text = textFromContent(p.content);
      if (text === null) continue;
      if (p.role === "assistant") {
        const message: Record<string, unknown> = {
          role: "assistant",
          model,
          content: [{ type: "text", text }],
        };
        if (pendingUsage) {
          message.usage = pendingUsage;
          pendingUsage = null;
        }
        yield { record: { type: "assistant", ...base(line), message }, line };
      } else if (p.role === "user" && !isEnvironmentContext(text)) {
        yield {
          record: {
            type: "user",
            ...base(line),
            message: { role: "user", content: [{ type: "text", text }] },
          },
          line,
        };
      }
      continue;
    }

    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const codexName = typeof p.name === "string" ? p.name : "unknown";
      // function_call → `arguments` (JSON string); custom_tool_call → `input` (raw string).
      const raw = p.type === "function_call" ? p.arguments : p.input;
      const { name, input } = mapToolCall(codexName, raw);
      const callId = typeof p.call_id === "string" ? p.call_id : `codex-call-${line}`;
      const message: Record<string, unknown> = {
        role: "assistant",
        model,
        content: [{ type: "tool_use", id: callId, name, input }],
      };
      if (pendingUsage) {
        message.usage = pendingUsage;
        pendingUsage = null;
      }
      yield { record: { type: "assistant", ...base(line), message }, line };
      continue;
    }

    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const callId = typeof p.call_id === "string" ? p.call_id : `codex-call-${line}`;
      const { content, isError } = parseToolOutput(p.output);
      yield {
        record: {
          type: "user",
          ...base(line),
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: callId, is_error: isError, content }],
          },
        },
        line,
      };
      continue;
    }
    // reasoning, ghost_snapshot, and unknown response_item types carry nothing metrics reads.
  }
}

async function countRecords(file: string): Promise<number> {
  let n = 0;
  for await (const _ of readRecords(file)) n += 1;
  return n;
}

export const codexSessionSource: SessionSource = {
  backend: "codex",
  storeLabel: "~/.codex/sessions/",
  validateSessionId,
  findSessionFile,
  readSessionMeta,
  readLaunchCwd,
  listWorkspaceSessions,
  readRecords,
  countRecords,
};
