import { defineCommand } from "citty";
import { DEFAULT_AGENT, getAgent } from "../agents/index.ts";
import { ensureServantAssets } from "../core/claude-setup.ts";
import { ensureCodexAssets } from "../core/codex-setup.ts";
import { requireInit } from "../core/config.ts";
import { applyRootOverride } from "../core/paths.ts";
import {
  ensureWorkspaceDir,
  isGoalUnfilled,
  readWorkspaceAgent,
  resolveWorkspaceName,
  writeWorkspaceAgent,
} from "../core/workspace.ts";
import { detectTerminal, getDriver } from "../terminals/index.ts";
import { addReposInteractive } from "./repo/add.ts";

// First message for an agent spawned into a workspace whose goal isn't defined yet
// (and no task was given): have it define GOAL.md before anything else. Phrased as
// natural language (not a bare `/servant:goal`) so it reliably triggers the command.
const GOAL_BOOTSTRAP_PROMPT =
  "This servant workspace has no goal defined yet. Run the /servant:goal command to interview me and define the workspace's GOAL.md before doing anything else.";

export const spawnCommand = defineCommand({
  meta: {
    name: "spawn",
    description:
      "Create a workspace folder under ~/.ai_servant/workspaces/<name> and open a new terminal tab running a coding agent in it.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description:
        "Workspace name (folder under ~/.ai_servant/workspaces). If omitted, auto-detected from cwd or current cmux workspace.",
    },
    terminal: {
      type: "string",
      required: false,
      description: "Terminal to use: cmux | iterm (default: auto-detect).",
    },
    agent: {
      type: "string",
      required: false,
      description: `Coding agent to launch: claude-code | codex. Defaults to the workspace's recorded agent, else ${DEFAULT_AGENT}.`,
    },
    prompt: {
      type: "string",
      required: false,
      alias: "p",
      description:
        "Initial prompt delivered to the agent as its first user message. Use to kick off a task (e.g. point the agent at a /handoff doc or a hub issue to continue).",
    },
    repo: {
      type: "boolean",
      required: false,
      alias: "r",
      default: false,
      description:
        "Before opening the tab, interactively pick local repo(s) and add a git worktree per selection under the workspace (same picker as `servant repo add`).",
    },
    branch: {
      type: "string",
      required: false,
      alias: "b",
      description:
        "With -r: override the auto-generated branch name. Defaults to <workspace>-<shortid>.",
    },
    base: {
      type: "string",
      required: false,
      description: "With -r: base ref to branch from (defaults to each repo's default branch).",
    },
    track: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "With -r: track the same-named remote branch on origin instead of branching from base.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    await requireInit();
    await ensureServantAssets();
    const workspace = await resolveWorkspaceName(args.workspace);
    const cwd = await ensureWorkspaceDir(workspace);
    // Whether the workspace still needs its goal defined. Checked after scaffolding so a
    // brand-new workspace reads its placeholder; true regardless of `-r` or prior spawns.
    const goalUnfilled = await isGoalUnfilled(workspace);

    // Add repos in the current TTY *before* opening the tab, so the worktrees exist
    // under the workspace by the time the agent starts there. The picker is interactive,
    // so it must run here rather than inside the freshly-spawned tab.
    if (args.repo) {
      await addReposInteractive({
        workspace,
        branch: args.branch,
        base: args.base,
        track: Boolean(args.track),
      });
    }

    // Resolve the backend: an explicit --agent wins; otherwise reuse whatever this workspace was
    // last spawned with (so a Codex workspace stays Codex, including via `/servant:delegate`), then
    // fall back to the default. Record the choice so future spawns and delegations inherit it.
    const agentName = args.agent?.trim() || (await readWorkspaceAgent(workspace)) || DEFAULT_AGENT;
    const agent = getAgent(agentName);
    await writeWorkspaceAgent(workspace, agent.name);
    // Codex discovers its slash-command prompts from ~/.codex/prompts; install servant's there.
    if (agent.name === "codex") await ensureCodexAssets();
    // If the caller gave a real task, run it. A blank prompt counts as no task — e.g.
    // `-repo` parses as the short-flag cluster `-r -e -p -o`, setting `-p` to "".
    const task = args.prompt?.trim() ? args.prompt : undefined;
    // Otherwise, if the workspace goal isn't defined yet, kick the agent off by defining it.
    const prompt = task ?? (goalUnfilled ? GOAL_BOOTSTRAP_PROMPT : undefined);
    const command = agent.launchCommand(cwd, { prompt });
    const driver = args.terminal ? getDriver(args.terminal) : await detectTerminal();

    await driver.openTab({ cwd, command, title: workspace });

    console.log(
      `servant: opened ${driver.name} tab for workspace "${workspace}" at ${cwd} running "${command}"`,
    );
  },
});
