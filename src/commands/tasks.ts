import { defineCommand } from "citty";
import { loadConfig } from "../core/config.ts";
import { applyRootOverride } from "../core/paths.ts";
import { type HubIssue, type IssueState, fetchHubTasks, groupByWorkspace } from "../core/tasks.ts";

function isIssueState(v: string): v is IssueState {
  return v === "open" || v === "closed" || v === "all";
}

function renderIssue(issue: HubIssue): string {
  const extra = issue.labels.filter((l) => !l.startsWith("ws:"));
  const tags = extra.length > 0 ? `  [${extra.join(", ")}]` : "";
  return `    #${issue.number}  ${issue.title}${tags}\n        ${issue.url}`;
}

export const tasksCommand = defineCommand({
  meta: {
    name: "tasks",
    description:
      "List the servant hub's tasks (GitHub Issues) grouped by workspace. Falls back to a cached snapshot when offline.",
  },
  args: {
    ws: {
      type: "string",
      required: false,
      description: "Only show tasks for this workspace (matches the ws:<name> label).",
    },
    state: {
      type: "string",
      required: false,
      default: "open",
      description: "Issue state: open (default), closed, or all.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const state: IssueState = isIssueState(String(args.state)) ? (args.state as IssueState) : "open";
    const { hubRepo } = await loadConfig();

    const { issues, fromCache, cachedAt } = await fetchHubTasks(hubRepo, state);
    const filtered = args.ws ? issues.filter((i) => i.workspace === args.ws) : issues;

    const scope = args.ws ? `workspace "${args.ws}"` : "all workspaces";
    const staleness = fromCache
      ? `  (offline — cached snapshot${cachedAt ? ` from ${new Date(cachedAt).toISOString()}` : ""})`
      : "";
    console.log(`servant: ${filtered.length} ${state} task(s) in ${hubRepo} · ${scope}${staleness}\n`);

    if (filtered.length === 0) {
      console.log(
        fromCache
          ? "  (no cached tasks — connect and re-run to populate)"
          : "  none — file one with /to-tickets or `gh issue create`.",
      );
      return;
    }

    for (const [workspace, group] of groupByWorkspace(filtered)) {
      console.log(`  ${workspace}  (${group.length})`);
      for (const issue of group.toSorted((a, b) => a.number - b.number)) {
        console.log(renderIssue(issue));
      }
      console.log("");
    }
  },
});
