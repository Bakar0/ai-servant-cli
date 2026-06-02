import { defineCommand } from "citty";
import { DEFAULT_AGENT, getAgent } from "../agents/index.ts";
import { ensureWorkspaceDir } from "../core/workspace.ts";
import { detectTerminal, getDriver } from "../terminals/index.ts";

export const spawnCommand = defineCommand({
  meta: {
    name: "spawn",
    description:
      "Create a workspace folder under ~/.ai_servant/<name> and open a new terminal tab running a coding agent in it.",
  },
  args: {
    workspace: {
      type: "string",
      required: true,
      alias: "w",
      description: "Workspace name (folder under ~/.ai_servant).",
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
    const cwd = await ensureWorkspaceDir(args.workspace);
    const agent = getAgent(args.agent);
    const command = agent.launchCommand(cwd);
    const driver = args.terminal ? getDriver(args.terminal) : await detectTerminal();

    await driver.openTab({ cwd, command, title: args.workspace });

    console.log(
      `servant: opened ${driver.name} tab for workspace "${args.workspace}" at ${cwd} running "${command}"`,
    );
  },
});
