import { defineCommand } from "citty";
import type { Ticket, TicketState } from "../core/board/store.ts";
import { applyRootOverride } from "../core/paths.ts";
import { readLiveSessionNames } from "../core/session-registry.ts";
import {
  type ClaimLiveness,
  blockerLabel,
  computeFrontier,
  groupByWorkspace,
  readTasks,
  refreshSessionProjection,
} from "../core/tasks.ts";

function isTicketState(v: string): v is TicketState {
  return v === "open" || v === "closed" || v === "all";
}

function renderTicket(ticket: Ticket): string {
  const tags = ticket.labels.length > 0 ? `  [${ticket.labels.join(", ")}]` : "";
  return `    #${ticket.seq}  ${ticket.title}${tags}\n        ${ticket.url}`;
}

export const tasksCommand = defineCommand({
  meta: {
    name: "tasks",
    description:
      "List the board's tickets grouped by workspace. Reads the local SQLite board — no network, no GitHub login, and it works whether or not the viewer is running.",
  },
  args: {
    ws: {
      type: "string",
      required: false,
      description: "Only show tickets on this workspace's board.",
    },
    state: {
      type: "string",
      required: false,
      default: "open",
      description: "Ticket state: open (default), closed, or all.",
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
    const state: TicketState = isTicketState(String(args.state))
      ? (args.state as TicketState)
      : "open";
    // Any command that runs refreshes the board's last-seen projection; this is what makes
    // staleness self-heal without a daemon (ADR-0011 decision 3).
    await refreshSessionProjection();

    // --frontier: what is dispatchable — the backstop /servant:handoff reads before it spawns
    // anything. Every ticket is read, not just this workspace's: a blocker on another board is
    // still a blocker.
    if (args.frontier) {
      const all = readTasks();
      const byId = new Map(all.map((t) => [t.id, t]));
      // A directory scan, never a question put to a session (workspace ADR 0010, decision 3).
      const live = await readLiveSessionNames();
      const liveness: ClaimLiveness = live.known
        ? { known: true, liveSessions: live.names }
        : { known: false };
      const { ready, stale, inFlight, blocked } = computeFrontier(all, liveness, {
        workspace: args.ws,
      });
      const blockerRefs = (b: { ticket: Ticket; openBlockers: number[] }) =>
        b.openBlockers.map((id) => byId.get(id)).filter((t): t is Ticket => t !== undefined);
      if (args.json) {
        const brief = (t: Ticket) => ({
          number: t.seq,
          workspace: t.workspace,
          id: t.id,
          title: t.title,
          url: t.url,
          labels: t.labels,
        });
        console.log(
          JSON.stringify({
            workspace: args.ws ?? null,
            /** Liveness reported as-is, so a consumer can tell "nobody is on it" from "cannot tell". */
            livenessKnown: liveness.known,
            ready: ready.map(brief),
            // Dispatchable too, but only after its dead Claim is reclaimed — which is cleanup, not
            // a decision, so /servant:handoff does it without asking.
            stale: stale.map((c) => ({
              ...brief(c.ticket),
              claim: { session: c.claim.session, since: c.claim.at },
            })),
            inFlight: inFlight.map((c) => ({
              ...brief(c.ticket),
              claim: { session: c.claim.session, since: c.claim.at },
              liveness: c.liveness,
            })),
            blocked: blocked.map((b) => ({
              ...brief(b.ticket),
              blockedBy: blockerRefs(b).map((t) => t.seq),
              // Qualified, because a bare number is ambiguous once an edge crosses boards.
              blockers: blockerRefs(b).map((t) => ({ workspace: t.workspace, seq: t.seq })),
            })),
          }),
        );
        return;
      }
      console.log(
        `servant: frontier for ${args.ws ? `"${args.ws}"` : "all workspaces"}${
          live.known ? "" : "  (session liveness unknown — claimed tickets shown as in-flight)"
        }\n`,
      );
      const section = (title: string, lines: string[]) => {
        console.log(`  ${title} (${lines.length}):`);
        console.log(lines.length ? lines.join("\n") : "    none");
        console.log("");
      };
      const at = (t: Ticket) => (args.ws ? `#${t.seq}` : `${t.workspace}#${t.seq}`);
      section(
        "ready — dispatchable now",
        ready.map((t) => `    ${at(t)}  ${t.title}`),
      );
      section(
        "stale — claim held by a session that is gone, reclaimable",
        stale.map((c) => `    ${at(c.ticket)}  ${c.ticket.title}   ← ${c.claim.session} (gone)`),
      );
      section(
        "in-flight — someone is on it",
        inFlight.map(
          (c) =>
            `    ${at(c.ticket)}  ${c.ticket.title}   ← ${c.claim.session}${
              c.liveness === "unknown" ? " (liveness unknown)" : ""
            }`,
        ),
      );
      section(
        "blocked",
        blocked.map(
          (b) =>
            `    ${at(b.ticket)}  ${b.ticket.title}   ← blocked-by ${blockerRefs(b)
              .map((t) => blockerLabel(t, b.ticket))
              .join(", ")}`,
        ),
      );
      return;
    }

    const tickets = readTasks({ workspace: args.ws, state });
    const scope = args.ws ? `workspace "${args.ws}"` : "all workspaces";
    console.log(`servant: ${tickets.length} ${state} ticket(s) on the board · ${scope}\n`);

    if (tickets.length === 0) {
      console.log("  none — file one with /to-tickets or `servant ticket new`.");
      return;
    }

    for (const [workspace, group] of groupByWorkspace(tickets)) {
      console.log(`  ${workspace}  (${group.length})`);
      for (const ticket of group) console.log(renderTicket(ticket));
      console.log("");
    }
  },
});
