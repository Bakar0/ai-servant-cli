import { defineCommand } from "citty";
import { DEFAULT_AGENT } from "../agents/index.ts";
import { applyRootOverride } from "../core/paths.ts";
import { launchWorkspaceSession } from "../core/spawn.ts";
import { addReposInteractive } from "./repo/add.ts";

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
    const session = await launchWorkspaceSession({
      workspace: args.workspace,
      agent: args.agent,
      prompt: args.prompt,
      terminal: args.terminal,
      // The picker is interactive, so it must run in this TTY, not the freshly-spawned tab.
      beforeLaunch: args.repo
        ? async ({ workspace }) => {
            await addReposInteractive({
              workspace,
              branch: args.branch,
              base: args.base,
              track: Boolean(args.track),
            });
          }
        : undefined,
    });

    console.log(
      `servant: opened ${session.terminal} tab for workspace "${session.workspace}" at ${session.cwd} running "${session.command}"`,
    );
  },
});
