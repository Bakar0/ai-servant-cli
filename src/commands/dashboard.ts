import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { buildWorkspaceDashboardData } from "../core/dashboard/data.ts";
import { renderWorkspaceDashboard } from "../core/dashboard/render.ts";
import { writeWorkspaceDashboard } from "../core/dashboard/store.ts";
import { openInDefaultApp } from "../core/open.ts";
import { applyRootOverride, workspacePath } from "../core/paths.ts";
import { resolveWorkspaceName } from "../core/workspace.ts";

export const dashboardCommand = defineCommand({
  meta: {
    name: "dashboard",
    description:
      "Render a self-contained HTML build-observability dashboard for a servant workspace (mission, where-we-are timeline, architecture), open it, and print its path. Deterministic: no agent, no model.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Target workspace (default: the current workspace).",
    },
    json: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Print the dashboard data payload as JSON and exit; do not render/write/open HTML.",
    },
    "no-open": {
      type: "boolean",
      required: false,
      default: false,
      description: "Write the dashboard and print its path, but don't open the browser.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const workspace = await resolveWorkspaceName(args.workspace as string | undefined);
    if (!existsSync(workspacePath(workspace))) {
      throw new Error(`Workspace "${workspace}" not found at ${workspacePath(workspace)}.`);
    }

    const data = buildWorkspaceDashboardData(workspace);
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const html = renderWorkspaceDashboard(data);
    const path = await writeWorkspaceDashboard(workspace, html);
    if (!args["no-open"]) openInDefaultApp(path);
    console.log(path);
  },
});
