import { DEFAULT_AGENT, getAgent } from "../agents/index.ts";
import { detectTerminal, getDriver } from "../terminals/index.ts";
import { ensureServantAssets } from "./claude-setup.ts";
import { ensureCodexAssets } from "./codex-setup.ts";
import { requireInit } from "./config.ts";
import {
  ensureWorkspaceDir,
  isGoalUnfilled,
  readWorkspaceAgent,
  resolveWorkspaceName,
  writeWorkspaceAgent,
} from "./workspace.ts";

// First message for an agent launched into a workspace whose goal isn't defined yet
// (and no task was given): have it define GOAL.md before anything else. Phrased as
// natural language (not a bare `/servant:goal`) so it reliably triggers the command.
const GOAL_BOOTSTRAP_PROMPT =
  "This servant workspace has no goal defined yet. Run the /servant:goal command to interview me and define the workspace's GOAL.md before doing anything else.";

export interface LaunchWorkspaceSessionOptions {
  workspace?: string | undefined;
  terminal?: string | undefined;
  agent?: string | undefined;
  prompt?: string | undefined;
  /**
   * Display name for the launched session, and the address anything that needs to reach it later
   * computes rather than searches for (workspace ADR 0010). Backends without a naming flag ignore it.
   */
  sessionName?: string | undefined;
  /** Permission mode for the launched session (e.g. `plan`, which cannot write). */
  permissionMode?: string | undefined;
  /**
   * Runs once the workspace is scaffolded and before the tab opens. `servant spawn -r` uses it to
   * run its interactive repo picker in the current TTY, so the worktrees exist by the time the
   * agent starts there. It lives here as a hook rather than as an option because the picker is a
   * command-layer concern — `core` has no business importing an interactive prompt.
   */
  beforeLaunch?: (ctx: { workspace: string; cwd: string }) => Promise<void>;
}

export interface LaunchedWorkspaceSession {
  workspace: string;
  cwd: string;
  terminal: string;
  command: string;
  /** Null when none was asked for, or when the backend has no way to name a session. */
  sessionName: string | null;
}

export async function launchWorkspaceSession(
  opts: LaunchWorkspaceSessionOptions,
): Promise<LaunchedWorkspaceSession> {
  await requireInit();
  await ensureServantAssets();
  const workspace = await resolveWorkspaceName(opts.workspace);
  const cwd = await ensureWorkspaceDir(workspace);
  // Checked after scaffolding so a brand-new workspace reads its placeholder.
  const goalUnfilled = await isGoalUnfilled(workspace);

  await opts.beforeLaunch?.({ workspace, cwd });

  // Resolve the backend: an explicit agent wins; otherwise reuse whatever this workspace was
  // last launched with (so a Codex workspace stays Codex), then fall back to the default. Record
  // the choice so future launches inherit it.
  const agentName = opts.agent?.trim() || (await readWorkspaceAgent(workspace)) || DEFAULT_AGENT;
  const agent = getAgent(agentName);
  await writeWorkspaceAgent(workspace, agent.name);
  // Codex discovers its slash-command prompts from ~/.codex/prompts; install servant's there.
  if (agent.name === "codex") await ensureCodexAssets();
  // A blank prompt counts as no task, not an empty first message — `servant spawn -repo`
  // parses as the short-flag cluster `-r -e -p -o`, which sets `-p` to "".
  const task = opts.prompt?.trim() ? opts.prompt : undefined;
  const prompt = task ?? (goalUnfilled ? GOAL_BOOTSTRAP_PROMPT : undefined);
  const sessionName = opts.sessionName?.trim() || undefined;
  const command = agent.launchCommand(cwd, {
    prompt,
    sessionName,
    permissionMode: opts.permissionMode,
  });
  const driver = opts.terminal ? getDriver(opts.terminal) : await detectTerminal();

  // The title stays the workspace even for a named session: cmux groups tabs by it, so naming the
  // tab after the session would scatter every Worker into a cmux workspace of its own.
  await driver.openTab({ cwd, command, title: workspace });

  return { workspace, cwd, terminal: driver.name, command, sessionName: sessionName ?? null };
}
