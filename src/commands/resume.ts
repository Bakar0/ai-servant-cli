import { defineCommand } from "citty";
import { getBackend } from "../agents/index.ts";
import { ensureCodexAssets } from "../core/codex-setup.ts";
import { ensureServantAssets } from "../core/claude-setup.ts";
import { type CmuxLiveState, readCmuxLiveStates } from "../core/cmux-sessions.ts";
import { applyRootOverride, workspacesRoot } from "../core/paths.ts";
import {
  type SessionMeta,
  type SessionSource,
  getSessionSource,
} from "../core/session-source.ts";
import {
  detectWorkspaceNameFromCwd,
  ensureWorkspaceDir,
  readWorkspaceAgent,
  resolveWorkspaceName,
} from "../core/workspace.ts";
import { detectTerminal, getDriver } from "../terminals/index.ts";
import { pickSession } from "../ui/resume-picker.ts";

// Backends whose session stores are searched (in order) when resuming a bare id with no --agent.
const KNOWN_BACKENDS = ["claude-code", "codex"] as const;

/**
 * Find which backend owns a session id. With an explicit backend, only that store is searched;
 * otherwise every known store is tried (Claude first) so a bare `servant resume <id>` still works.
 */
async function locateSession(
  id: string,
  explicitBackend: string | undefined,
): Promise<{ source: SessionSource; file: string } | null> {
  const backends = explicitBackend ? [explicitBackend] : [...KNOWN_BACKENDS];
  let anyValid = false;
  for (const backend of backends) {
    const source = getSessionSource(backend);
    try {
      source.validateSessionId(id);
    } catch {
      continue; // wrong id shape for this backend — try the next store
    }
    anyValid = true;
    const file = await source.findSessionFile(id);
    if (file) return { source, file };
  }
  // Malformed for every candidate backend → surface the validation error (clearer than "not found").
  if (!anyValid) getSessionSource(backends[0]).validateSessionId(id);
  return null;
}

export const resumeCommand = defineCommand({
  meta: {
    name: "resume",
    description:
      "Re-attach to a previous Claude Code session by id. With no id, open an fzf picker over the current workspace's session history.",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "Session id (UUID). If omitted, open the interactive picker.",
    },
    agent: {
      type: "string",
      required: false,
      description:
        "Backend to resume with: claude-code | codex. Defaults to the workspace's recorded agent, else auto-detected from the id's store.",
    },
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description:
        "Workspace name to scope the picker to (default: auto-detect; falls back to cross-workspace mode).",
    },
    terminal: {
      type: "string",
      required: false,
      description: "Terminal to use when --new-tab is set: cmux | iterm (default: auto-detect).",
    },
    "new-tab": {
      type: "boolean",
      required: false,
      description: "Open a new terminal tab instead of running claude in the current tab.",
    },
    prompt: {
      type: "string",
      required: false,
      alias: "p",
      description:
        "Optional follow-up message appended after --resume; Claude reads it as the next user turn.",
    },
    preview: {
      type: "string",
      required: false,
      description: "(internal) Render the preview pane for a session id and exit.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const explicitBackend = (args.agent as string | undefined)?.trim() || undefined;
    if (typeof args.preview === "string" && args.preview.length > 0) {
      await renderPreviewToStdout(args.preview, getSessionSource(explicitBackend));
      return;
    }

    const explicitWs = args.workspace as string | undefined;
    let source: SessionSource;
    let file: string;
    let sessionId: string;

    const providedId = (args.id as string | undefined) ?? null;
    if (!providedId) {
      // Picker mode: scope to the workspace and pick from its recorded backend's store.
      const workspaceName =
        explicitWs ?? (await resolveWorkspaceName(undefined, { allowUnresolved: true }));
      const backend =
        explicitBackend ??
        (workspaceName ? await readWorkspaceAgent(workspaceName) : null) ??
        "claude-code";
      source = getSessionSource(backend);
      const picked = await pickSession({ workspaceName: workspaceName ?? undefined, source });
      if (!picked) return;
      sessionId = picked;
      const found = await source.findSessionFile(sessionId);
      if (!found) throw new Error(`Session ${sessionId} disappeared from ${source.storeLabel}.`);
      file = found;
    } else {
      const located = await locateSession(providedId, explicitBackend);
      if (!located) {
        const where = explicitBackend
          ? getSessionSource(explicitBackend).storeLabel
          : "any known agent's session store";
        throw new Error(
          `No session file found for ${providedId} under ${where}. The session may have been deleted.`,
        );
      }
      ({ source, file } = located);
      sessionId = providedId;
    }

    const launchCwd = await source.readLaunchCwd(file);
    if (!launchCwd) {
      throw new Error(`Session ${sessionId} has no cwd recorded — can't resume safely.`);
    }

    const workspaceTitle = resolveWorkspaceTitle(explicitWs, launchCwd);
    const prompt = args.prompt as string | undefined;
    const backend = getBackend(source.backend);

    if (workspaceTitle && isUnderWorkspacesRoot(launchCwd)) {
      await ensureWorkspaceDir(workspaceTitle);
    }
    await ensureServantAssets();
    if (backend.name === "codex") await ensureCodexAssets();

    const newTab = args["new-tab"];
    if (newTab) {
      const terminalName = args.terminal as string | undefined;
      const driver = terminalName ? getDriver(terminalName) : await detectTerminal();
      const command = backend.resumeCommand(sessionId, prompt);
      await driver.openTab({ cwd: launchCwd, command, title: workspaceTitle ?? undefined });
      console.log(
        `servant: resumed ${backend.name} session ${sessionId.slice(0, 8)} in ${driver.name} workspace "${workspaceTitle ?? launchCwd}" at ${launchCwd}`,
      );
      return;
    }

    const exitCode = await runInPlace(backend.resumeArgv(sessionId, prompt), launchCwd);
    if (exitCode !== 0) process.exit(exitCode);
  },
});

async function runInPlace(argv: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

export function buildResumeCommand(id: string, prompt?: string): string {
  return getBackend("claude-code").resumeCommand(id, prompt);
}

export function resolveWorkspaceTitle(
  explicit: string | undefined,
  launchCwd: string,
): string | null {
  if (explicit) return explicit;
  return detectWorkspaceNameFromCwd(launchCwd, workspacesRoot());
}

export function isUnderWorkspacesRoot(cwd: string): boolean {
  return detectWorkspaceNameFromCwd(cwd, workspacesRoot()) !== null;
}

async function renderPreviewToStdout(id: string, source: SessionSource): Promise<void> {
  try {
    source.validateSessionId(id);
    const file = await source.findSessionFile(id);
    if (!file) {
      process.stdout.write(`<no session file found for ${id}>\n`);
      return;
    }
    const meta = await source.readSessionMeta(file);
    // Live state is a cmux/Claude signal; Codex has no equivalent yet, so it degrades to "stored".
    const live = source.backend === "claude-code" ? (await readCmuxLiveStates()).get(id) : undefined;
    process.stdout.write(formatPreview(meta, live));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`<could not load session: ${msg}>\n`);
  }
}

export function formatPreview(meta: SessionMeta, live: CmuxLiveState | undefined): string {
  const lines: string[] = [];
  lines.push(`Session   ${meta.sessionId}`);
  lines.push(`Workspace ${meta.workspaceName ?? "(none)"}`);
  if (live) {
    const surface = live.surfaceId ? live.surfaceId.replace(/^.*:/, "") : null;
    const suffix = surface ? `   (live; surface ${surface})` : "   (live)";
    lines.push(`State     ${live.agentLifecycle ?? "unknown"}${suffix}`);
  } else {
    lines.push("State     stored");
  }
  const updated = new Date(meta.mtimeMs);
  lines.push(`Updated   ${updated.toISOString()}  (${relativeAge(meta.mtimeMs)})`);
  lines.push(`Turns     ${meta.userTurns} user / ${meta.assistantTurns} assistant`);
  lines.push(`Launch    ${collapseHome(meta.launchCwd)}`);
  if (meta.latestCwd && meta.latestCwd !== meta.launchCwd) {
    lines.push(`Cwd now   ${collapseHome(meta.latestCwd)}`);
  }
  lines.push("");
  lines.push("--- First user message ---");
  lines.push(truncate(meta.firstUserMessage ?? "(none)", 2000));
  lines.push("");
  lines.push("--- Last user message ---");
  lines.push(truncate(meta.lastUserMessage ?? "(none)", 2000));
  lines.push("");
  lines.push("--- Last assistant message ---");
  lines.push(truncate(meta.lastAssistantMessage ?? "(none)", 2000));
  lines.push("");
  return lines.join("\n");
}

function collapseHome(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  if (home && path === home) return "~";
  return path;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

function relativeAge(mtimeMs: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - mtimeMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} minutes ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} hours ago`;
  return `${Math.floor(diffMs / day)} days ago`;
}
