export interface LaunchOptions {
  /**
   * Initial prompt to deliver to the agent as its first user message.
   * The agent layer is responsible for safely embedding it in the shell command.
   */
  prompt?: string;
  /**
   * Extra directories to bring into the agent's tool scope (`--add-dir`), beyond its cwd.
   * Used by the interactive analyst session to reach transcripts under the agent's session store
   * without a permission prompt per drill. Interactive launches only — never the headless runners.
   */
  addDirs?: readonly string[];
  /**
   * Display name for the launched session, which is also its *address*: every session in one
   * workspace shares a cwd, so a backend's own derived naming produces near-identical names that
   * nothing can resolve a ticket to. Backends with no naming flag ignore it (workspace ADR 0010).
   */
  sessionName?: string;
}

/** Describes the agent's project-conventions document (Claude reads `CLAUDE.md`; Codex `AGENTS.md`). */
export interface ConventionsDoc {
  /** The filename the agent auto-loads from its cwd (`CLAUDE.md` / `AGENTS.md`). */
  filename: string;
  /**
   * Whether the doc supports `@path` imports (Claude does; Codex's AGENTS.md is plain text). When
   * false, servant must inline referenced content rather than link to it.
   */
  supportsImports: boolean;
}

/** Describes where and how servant's slash-command prompts install for this agent. */
export interface PromptsSpec {
  /**
   * Absolute directory the agent discovers slash-command / prompt files in. Claude uses the servant
   * root's `.claude/commands/servant/`; Codex uses `~/.codex/prompts/`.
   */
  dir(): string;
  /**
   * Turn a servant command id (`goal`, `handoff`, …) into the filename the agent expects. Claude
   * namespaces via directory (`goal.md` → `/servant:goal`); Codex is flat and has no `:` namespace,
   * so it prefixes the filename (`servant-goal.md` → `/servant-goal`).
   */
  filename(commandId: string): string;
}

/**
 * How a backend keeps servant's own headless runs from being measured as user sessions. Claude
 * pre-assigns a session id (`--session-id`) and registers it for exclusion; Codex has no such flag
 * but can run `--ephemeral` so the run never persists a session file at all.
 */
export type HeadlessSelfExclusion = "session-id" | "ephemeral";

export interface ExtractionArgvOptions {
  /** Pre-resolved model flag args (e.g. `["--model","sonnet"]` or `[]`). */
  modelArgs: readonly string[];
  /** A directory to bring into tool scope (the knowledge store, for extraction). */
  addDir: string;
}

export interface JudgeArgvOptions extends ExtractionArgvOptions {
  /**
   * The pre-assigned session id, for backends whose self-exclusion is `"session-id"`. Ignored by
   * `"ephemeral"` backends.
   */
  sessionId: string;
}

export interface HeadlessSpec {
  selfExclusion: HeadlessSelfExclusion;
  /** Argv (including the binary) for the headless memory-extraction pass. */
  extractionArgv(prompt: string, opts: ExtractionArgvOptions): string[];
  /** Argv (including the binary) for the headless insight-judgment pass. */
  judgeArgv(prompt: string, opts: JudgeArgvOptions): string[];
}

/** The minimal launch contract (kept for callers that only need to open a tab). */
export interface CodingAgent {
  readonly name: string;
  launchCommand(cwd: string, opts?: LaunchOptions): string;
}

/**
 * A full coding-agent backend: everything servant needs to launch, resume, and headlessly drive
 * one agent CLI, plus the metadata that tells servant how to write that agent's conventions doc and
 * slash-command prompts. `claude-code` and `codex` each implement this.
 *
 * Transcript ingestion (session discovery + record parsing) is a separate seam (`SessionSource`)
 * introduced alongside the Codex ingestion adapter.
 */
export interface AgentBackend extends CodingAgent {
  /** Shell command to resume a session in a new terminal tab. */
  resumeCommand(sessionId: string, prompt?: string): string;
  /** Argv (including the binary) to resume a session in-place in the current tab. */
  resumeArgv(sessionId: string, prompt?: string): string[];
  readonly conventions: ConventionsDoc;
  readonly prompts: PromptsSpec;
  readonly headless: HeadlessSpec;
}
