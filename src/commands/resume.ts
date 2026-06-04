import { defineCommand } from "citty";
import {
  type ClaudeSessionMeta,
  assertValidSessionId,
  findSessionJsonl,
  readLaunchCwd,
  readSessionMeta,
} from "../core/claude-session.ts";
import { ensureServantAssets } from "../core/claude-setup.ts";
import { type CmuxLiveState, readCmuxLiveStates } from "../core/cmux-sessions.ts";
import { workspacesRoot } from "../core/paths.ts";
import { shellSingleQuote } from "../core/shell.ts";
import {
  detectWorkspaceNameFromCwd,
  ensureWorkspaceDir,
  resolveWorkspaceName,
} from "../core/workspace.ts";
import { detectTerminal, getDriver } from "../terminals/index.ts";
import { pickSession } from "../ui/resume-picker.ts";

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
      description: "Claude session id (UUID). If omitted, open the interactive picker.",
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
      description: "Terminal to use: cmux | iterm (default: auto-detect).",
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
  },
  async run({ args }) {
    if (typeof args.preview === "string" && args.preview.length > 0) {
      await renderPreviewToStdout(args.preview);
      return;
    }

    let sessionId = (args.id as string | undefined) ?? null;
    if (!sessionId) {
      const explicitWs = args.workspace as string | undefined;
      const workspaceName =
        explicitWs ?? (await resolveWorkspaceName(undefined, { allowUnresolved: true }));
      sessionId = await pickSession({ workspaceName: workspaceName ?? undefined });
      if (!sessionId) return;
    } else {
      assertValidSessionId(sessionId);
    }

    const jsonlPath = await findSessionJsonl(sessionId);
    if (!jsonlPath) {
      throw new Error(
        `No session file found for ${sessionId} under ~/.claude/projects/. The session may have been deleted.`,
      );
    }
    const launchCwd = await readLaunchCwd(jsonlPath);
    if (!launchCwd) {
      throw new Error(`Session ${sessionId} has no cwd recorded — can't resume safely.`);
    }

    const explicitWs = args.workspace as string | undefined;
    const workspaceTitle = resolveWorkspaceTitle(explicitWs, launchCwd);

    const command = buildResumeCommand(sessionId, args.prompt as string | undefined);

    if (workspaceTitle && isUnderWorkspacesRoot(launchCwd)) {
      await ensureWorkspaceDir(workspaceTitle);
    }
    await ensureServantAssets();

    const terminalName = args.terminal as string | undefined;
    const driver = terminalName ? getDriver(terminalName) : await detectTerminal();
    await driver.openTab({ cwd: launchCwd, command, title: workspaceTitle ?? undefined });

    console.log(
      `servant: resumed session ${sessionId.slice(0, 8)} in ${driver.name} workspace "${workspaceTitle ?? launchCwd}" at ${launchCwd}`,
    );
  },
});

export function buildResumeCommand(id: string, prompt?: string): string {
  const base = `claude --resume ${shellSingleQuote(id)}`;
  const trimmed = prompt?.trim();
  if (!trimmed) return base;
  return `${base} ${shellSingleQuote(trimmed)}`;
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

async function renderPreviewToStdout(id: string): Promise<void> {
  try {
    assertValidSessionId(id);
    const jsonlPath = await findSessionJsonl(id);
    if (!jsonlPath) {
      process.stdout.write(`<no session file found for ${id}>\n`);
      return;
    }
    const meta = await readSessionMeta(jsonlPath);
    const live = (await readCmuxLiveStates()).get(id);
    process.stdout.write(formatPreview(meta, live));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`<could not load session: ${msg}>\n`);
  }
}

export function formatPreview(meta: ClaudeSessionMeta, live: CmuxLiveState | undefined): string {
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
