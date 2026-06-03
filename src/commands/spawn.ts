import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { DEFAULT_AGENT, getAgent } from "../agents/index.ts";
import { aiServantRoot, workspacePath } from "../core/paths.ts";
import {
  assertValidWorkspaceName,
  detectWorkspaceNameFromCwd,
  ensureWorkspaceDir,
} from "../core/workspace.ts";
import { getCurrentCmuxWorkspaceTitle } from "../terminals/cmux.ts";
import { detectTerminal, getDriver } from "../terminals/index.ts";

async function resolveWorkspaceName(provided: string | undefined): Promise<string> {
  if (provided) return provided;

  const root = aiServantRoot();
  const fromCwd = detectWorkspaceNameFromCwd(process.cwd(), root);
  if (fromCwd) return fromCwd;

  const inCmux = Boolean(process.env.CMUX_WORKSPACE_ID);
  let cmuxTitle: string | null = null;
  if (inCmux) {
    cmuxTitle = await getCurrentCmuxWorkspaceTitle();
    if (cmuxTitle) {
      try {
        assertValidWorkspaceName(cmuxTitle);
        if (existsSync(workspacePath(cmuxTitle))) return cmuxTitle;
      } catch {
        // fall through to error
      }
    }
  }

  const tried = [`cwd ${process.cwd()} is not under ${root}/<name>`];
  if (!inCmux) {
    tried.push("cmux workspace identity: not running inside cmux");
  } else if (cmuxTitle === null) {
    tried.push("cmux workspace identity: could not resolve current cmux workspace");
  } else {
    tried.push(`cmux workspace "${cmuxTitle}": no matching folder at ${workspacePath(cmuxTitle)}`);
  }
  throw new Error(
    `Could not auto-detect workspace. Tried:\n  - ${tried.join("\n  - ")}\nPass --workspace <name> explicitly.`,
  );
}

export const spawnCommand = defineCommand({
  meta: {
    name: "spawn",
    description:
      "Create a workspace folder under ~/.ai_servant/<name> and open a new terminal tab running a coding agent in it.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description:
        "Workspace name (folder under ~/.ai_servant). If omitted, auto-detected from cwd or current cmux workspace.",
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
