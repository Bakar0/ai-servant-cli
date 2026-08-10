import { defineCommand } from "citty";
import { loadConfig } from "../core/config.ts";
import { applyRootOverride } from "../core/paths.ts";
import { readLiveSessionNames } from "../core/session-registry.ts";
import {
  type ClaimLiveness,
  type HubIssue,
  type IssueState,
  computeFrontier,
  defaultNativeBlockersRunner,
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
        "Classify open tickets as ready, in-flight (a live session holds the Claim), stale (the holding session is gone) or blocked. Used by /servant:handoff to pick dispatchable tickets.",
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

    // Dependencies cost extra API calls, so they are only read for --frontier, which is the one
    // caller whose answer is wrong without them (majordomo#23).
    const { issues, fromCache, cachedAt } = await fetchHubTasks(
      hubRepo,
      state,
      args.frontier ? { nativeRunner: defaultNativeBlockersRunner } : {},
    );
    const filtered = args.ws ? issues.filter((i) => i.workspace === args.ws) : issues;

    // --frontier: what is dispatchable, from every blocking form and every Claim — the backstop
    // /servant:handoff reads before it spawns anything.
    if (args.frontier) {
      // A directory scan, never a question put to a session (workspace ADR 0010, decision 3).
      // It degrades to unknown rather than to a short list of names — see `liveSessionNames`.
      const live = await readLiveSessionNames();
      const liveness: ClaimLiveness = live.known
        ? { known: true, liveSessions: live.names }
        : { known: false };
      const { ready, stale, inFlight, blocked } = computeFrontier(filtered, liveness);
      if (args.json) {
        console.log(
          JSON.stringify({
            hubRepo,
            workspace: args.ws ?? null,
            fromCache,
            /** Liveness reported as-is, so a consumer can tell "nobody is on it" from "cannot tell". */
            livenessKnown: liveness.known,
            ready: ready.map((i) => ({
              number: i.number,
              title: i.title,
              url: i.url,
              labels: i.labels,
            })),
            // Dispatchable too, but only after its dead Claim is reclaimed — which is cleanup, not
            // a decision, so /servant:handoff does it without asking.
            stale: stale.map((c) => ({
              number: c.issue.number,
              title: c.issue.title,
              url: c.issue.url,
              labels: c.issue.labels,
              claim: { session: c.claim.session, since: c.claim.at },
            })),
            inFlight: inFlight.map((c) => ({
              number: c.issue.number,
              title: c.issue.title,
              url: c.issue.url,
              claim: { session: c.claim.session, since: c.claim.at },
              liveness: c.liveness,
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
        }${live.known ? "" : "  (session liveness unknown — claimed tickets shown as in-flight)"}\n`,
      );
      const section = (title: string, lines: string[]) => {
        console.log(`  ${title} (${lines.length}):`);
        console.log(lines.length ? lines.join("\n") : "    none");
        console.log("");
      };
      section(
        "ready — dispatchable now",
        ready.map((i) => `    #${i.number}  ${i.title}`),
      );
      section(
        "stale — claim held by a session that is gone, reclaimable",
        stale.map((c) => `    #${c.issue.number}  ${c.issue.title}   ← ${c.claim.session} (gone)`),
      );
      section(
        "in-flight — someone is on it",
        inFlight.map(
          (c) =>
            `    #${c.issue.number}  ${c.issue.title}   ← ${c.claim.session}${
              c.liveness === "unknown" ? " (liveness unknown)" : ""
            }`,
        ),
      );
      section(
        "blocked",
        blocked.map(
          (b) =>
            `    #${b.issue.number}  ${b.issue.title}   ← blocked-by ${b.openBlockers
              .map((n) => `#${n}`)
              .join(", ")}`,
        ),
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
