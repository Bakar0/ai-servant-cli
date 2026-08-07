import {
  type ClaudeSessionMeta,
  type ListSessionsOpts,
  assertValidSessionId,
  claudeProjectsRoot,
  countTranscriptEntries,
  findSessionJsonl,
  listWorkspaceSessions,
  readJsonlLinesWithLineNumbers,
  readLaunchCwd,
  readSessionMeta,
} from "./claude-session.ts";
import { codexSessionSource } from "./codex-session.ts";

// A backend-agnostic view over a coding agent's on-disk session store. Claude reads
// `~/.claude/projects/<enc-cwd>/<uuid>.jsonl`; Codex reads `~/.codex/sessions/**/rollout-*.jsonl`.
// Everything that discovers or previews sessions (resume, the picker, insights) goes through this
// so it works the same for either backend. Transcript *record* parsing for metrics is layered on
// top via `readRecords` (a normalized turn model), added with the Codex ingestion adapter.

export type SessionMeta = ClaudeSessionMeta;

export interface SessionSource {
  /** Backend name this source serves (`"claude-code"` | `"codex"`). */
  readonly backend: string;
  /** Human-facing label for the on-disk store, used in "not found" messages. */
  readonly storeLabel: string;
  /** Throw if `id` is not a well-formed session id for this backend. */
  validateSessionId(id: string): void;
  /** Absolute path to the session's transcript file, or null if none exists. */
  findSessionFile(id: string): Promise<string | null>;
  /** Parse a session's metadata (turns, first/last messages, model, cwd, mtime). */
  readSessionMeta(file: string): Promise<SessionMeta>;
  /** The cwd a session was launched from (for safe resume), or null. */
  readLaunchCwd(file: string): Promise<string | null>;
  /** Sessions belonging to servant workspaces, newest first (see {@link ListSessionsOpts}). */
  listWorkspaceSessions(opts?: ListSessionsOpts): Promise<SessionMeta[]>;
  /**
   * Yield the session's transcript as **Claude-shaped records** with their 1-based physical line
   * number (the transcript anchor), so `metrics.ts` can parse either backend with one code path.
   * For Claude this is the raw JSONL; the Codex source maps each rollout line into the equivalent
   * Claude record (assistant `message` with `usage`/`tool_use`, user `tool_result`, …).
   */
  readRecords(file: string): AsyncGenerator<{ record: unknown; line: number }>;
  /** Count parseable records (the unit the extraction turn-marker advances over). */
  countRecords(file: string): Promise<number>;
}

const claudeSessionSource: SessionSource = {
  backend: "claude-code",
  storeLabel: "~/.claude/projects/",
  validateSessionId: assertValidSessionId,
  findSessionFile: findSessionJsonl,
  readSessionMeta,
  readLaunchCwd,
  listWorkspaceSessions,
  readRecords: readJsonlLinesWithLineNumbers,
  countRecords: countTranscriptEntries,
};

// Claude's transcript root is used by fine-tune's `--add-dir`; re-exported here so callers that
// think in terms of "the session store" don't reach back into claude-session.ts directly.
export { claudeProjectsRoot };

/** Resolve the session source for a backend. Unknown backends fall back to Claude (back-compat). */
export function getSessionSource(backend: string | null | undefined): SessionSource {
  return backend === "codex" ? codexSessionSource : claudeSessionSource;
}
