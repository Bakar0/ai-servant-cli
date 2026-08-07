import { defineCommand } from "citty";
import { loadConfig } from "../core/config.ts";
import { applyRootOverride } from "../core/paths.ts";
import {
  type HubIssue,
  type IssueState,
  computeFrontier,
  fetchHubTasks,
  groupByWorkspace,
} from "../core/tasks.ts";

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
    frontier: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Classify open tickets as ready (blockers closed) vs blocked, from their Blocked-by edges. Used by /servant:handoff to pick dispatchable tickets.",
    },
    json: {
      type: "boolean",
      required: false,
      default: false,
      description: "Emit machine-readable JSON (honored with --frontier).",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const state: IssueState = isIssueState(String(args.state))
      ? (args.state as IssueState)
      : "open";
    const { hubRepo } = await loadConfig();

    const { issues, fromCache, cachedAt } = await fetchHubTasks(hubRepo, state);
    const filtered = args.ws ? issues.filter((i) => i.workspace === args.ws) : issues;

    // --frontier: classify ready vs blocked (dependency-aware), the backstop /servant:handoff reads.
    if (args.frontier) {
      const { ready, blocked } = computeFrontier(filtered);
      if (args.json) {
        console.log(
          JSON.stringify({
            hubRepo,
            workspace: args.ws ?? null,
            fromCache,
            ready: ready.map((i) => ({
              number: i.number,
              title: i.title,
              url: i.url,
              labels: i.labels,
            })),
            blocked: blocked.map((b) => ({
              number: b.issue.number,
              title: b.issue.title,
              url: b.issue.url,
              blockedBy: b.openBlockers,
            })),
          }),
        );
        return;
      }
      console.log(
        `servant: frontier for ${args.ws ? `"${args.ws}"` : "all workspaces"} in ${hubRepo}${
          fromCache ? "  (offline cache)" : ""
        }\n`,
      );
      console.log(`  ready (${ready.length}) — dispatchable now:`);
      console.log(
        ready.length ? ready.map((i) => `    #${i.number}  ${i.title}`).join("\n") : "    none",
      );
      console.log(`\n  blocked (${blocked.length}):`);
      console.log(
        blocked.length
          ? blocked
              .map(
                (b) =>
                  `    #${b.issue.number}  ${b.issue.title}   ← blocked-by ${b.openBlockers
                    .map((n) => `#${n}`)
                    .join(", ")}`,
              )
              .join("\n")
          : "    none",
      );
      return;
    }

    const scope = args.ws ? `workspace "${args.ws}"` : "all workspaces";
    const staleness = fromCache
      ? `  (offline — cached snapshot${cachedAt ? ` from ${new Date(cachedAt).toISOString()}` : ""})`
      : "";
    console.log(
      `servant: ${filtered.length} ${state} task(s) in ${hubRepo} · ${scope}${staleness}\n`,
    );

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
