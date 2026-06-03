import { defineCommand } from "citty";
import { DEFAULT_AGENT, getAgent } from "../agents/index.ts";
import { ensureWorkspaceDir, resolveWorkspaceName } from "../core/workspace.ts";
import { detectTerminal, getDriver } from "../terminals/index.ts";

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
      default: DEFAULT_AGENT,
      description: `Coding agent to launch (default: ${DEFAULT_AGENT}).`,
    },
  },
  async run({ args }) {
    const workspace = await resolveWorkspaceName(args.workspace);
    const cwd = await ensureWorkspaceDir(workspace);
    const agent = getAgent(args.agent);
    const command = agent.launchCommand(cwd);
    const driver = args.terminal ? getDriver(args.terminal) : await detectTerminal();

    await driver.openTab({ cwd, command, title: workspace });

    console.log(
      `servant: opened ${driver.name} tab for workspace "${workspace}" at ${cwd} running "${command}"`,
    );
  },
});
