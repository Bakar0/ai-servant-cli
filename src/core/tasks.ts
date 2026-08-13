// `servant tasks`: what is on the board, and what of it is dispatchable.
//
// The tracker is a local SQLite board (ADR-0011), so nothing here touches the network and there is
// no cache tier — an offline snapshot only ever existed because `gh` might not answer. The bucket
// logic below is unchanged from the hub era; only where blockers come from changed.

import type { Claim, Ticket, TicketState } from "./board/store.ts";
import { isOpenStatus, listTickets, recordSessionsSeen } from "./board/store.ts";
import { readLiveSessions } from "./session-registry.ts";

export type { Ticket, TicketState, TicketStatus, Claim } from "./board/store.ts";

/** Read the board. The whole of `servant tasks`' input, and it cannot fail for network reasons. */
export function readTasks(opts: { workspace?: string | undefined; state?: TicketState } = {}) {
  return listTickets(opts);
}

/**
 * Write what the session registry currently reports into the board's last-seen projection.
 *
 * Called by whichever servant command happens to run, which is what makes staleness self-heal with
 * no daemon (ADR-0011 decision 3). Never the authority on liveness — that stays the PID check — so
 * a registry this host cannot read is simply nothing to record, not an error.
 */
export async function refreshSessionProjection(now?: string): Promise<void> {
  const live = await readLiveSessions();
  if (!live.known) return;
  const named = live.sessions.filter((s) => s.name !== null);
  if (named.length === 0) return;
  recordSessionsSeen(
    named.map((s) => ({ name: s.name as string, pid: s.pid })),
    now === undefined ? {} : { now },
  );
}

/** Group tickets by their board. Membership is structural now, not a label that can be forgotten. */
export function groupByWorkspace(tickets: readonly Ticket[]): Map<string, Ticket[]> {
  const out = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    const bucket = out.get(ticket.workspace);
    if (bucket) bucket.push(ticket);
    else out.set(ticket.workspace, [ticket]);
  }
  return new Map([...out.entries()].toSorted((a, b) => a[0].localeCompare(b[0])));
}

/** A Claim, paired with the ticket it sits on. */
export interface ClaimedTicket {
  ticket: Ticket;
  claim: Claim;
}

/**
 * What this host can say about which sessions are running. Degrades to unknown, and unknown is an
 * ordinary answer — never an error — because liveness is the most valuable thing here and the
 * least safe to depend on (workspace ADR 0010, decision 3).
 */
export type ClaimLiveness = { known: false } | { known: true; liveSessions: readonly string[] };

/**
 * The frontier, in four disjoint buckets. Only two of them are dispatchable, and which two is the
 * whole point: `ready` is free to take, `stale` needs its dead Claim reclaimed first, and the
 * other two are refusals.
 */
export interface Frontier {
  /** Unblocked and unclaimed — safe to dispatch now. */
  ready: Ticket[];
  /**
   * Unblocked, but claimed by a session that is gone. Dispatchable once the Claim is reclaimed,
   * which `/servant:handoff` does silently — it is cleanup, not a decision.
   */
  stale: ClaimedTicket[];
  /**
   * Claimed by a session that is still running, or whose liveness could not be determined. Both
   * are refusals: a ticket we cannot prove is free must not be handed out twice.
   */
  inFlight: (ClaimedTicket & { liveness: "alive" | "unknown" })[];
  /** Open tickets still waiting, each with the global ids of the blockers that are still open. */
  blocked: { ticket: Ticket; openBlockers: number[] }[];
}

/**
 * Sort open tickets into ready / stale / in-flight / blocked.
 *
 * Pure, with liveness injected. A blocker counts only while it is still open; a closed one is
 * satisfied. There is no "blockers were not read" case any more — that state existed solely to stop
 * the frontier dispatching onto an unbuilt prerequisite when `gh` failed to answer (ADR-0011
 * decision 6), and a local database answers.
 *
 * Pass **every** ticket and narrow with `opts.workspace` rather than pre-filtering: a blocker on
 * another board is still a blocker, and filtering first would report a cross-board dependency as
 * satisfied because its blocker was not in the set.
 */
export function computeFrontier(
  tickets: readonly Ticket[],
  liveness: ClaimLiveness = { known: false },
  opts: { workspace?: string | undefined } = {},
): Frontier {
  const openIds = new Set(tickets.filter((t) => isOpenStatus(t.status)).map((t) => t.id));
  const open = tickets.filter(
    (t) => isOpenStatus(t.status) && (!opts.workspace || t.workspace === opts.workspace),
  );
  const live = new Set(liveness.known ? liveness.liveSessions : []);
  const ready: Ticket[] = [];
  const stale: ClaimedTicket[] = [];
  const inFlight: (ClaimedTicket & { liveness: "alive" | "unknown" })[] = [];
  const blocked: { ticket: Ticket; openBlockers: number[] }[] = [];

  for (const ticket of open) {
    const openBlockers = ticket.blockedBy.filter((id) => openIds.has(id));
    // Blocked wins over any Claim: whoever is carrying it, the prerequisite still does not exist.
    if (openBlockers.length > 0) {
      blocked.push({ ticket, openBlockers });
      continue;
    }
    const claim = ticket.claim;
    if (!claim) {
      ready.push(ticket);
      continue;
    }
    // Staleness is the session being *absent*, never elapsed time — a session idle for days is
    // alive and still legitimately holds its ticket. So an unreadable registry cannot conclude
    // stale, and reports in-flight instead.
    if (!liveness.known) inFlight.push({ ticket, claim, liveness: "unknown" });
    else if (live.has(claim.session)) inFlight.push({ ticket, claim, liveness: "alive" });
    else stale.push({ ticket, claim });
  }

  const order = (a: Ticket, b: Ticket) =>
    a.workspace === b.workspace ? a.seq - b.seq : a.workspace.localeCompare(b.workspace);
  ready.sort(order);
  const byTicket = (a: { ticket: Ticket }, b: { ticket: Ticket }) => order(a.ticket, b.ticket);
  stale.sort(byTicket);
  inFlight.sort(byTicket);
  blocked.sort(byTicket);
  return { ready, stale, inFlight, blocked };
}

/**
 * How a blocker is named to a human. Qualified with its board whenever the edge crosses one, so a
 * bare number is never ambiguous; bare inside a single board, where a number is the address.
 */
export function blockerLabel(blocker: Ticket, from: Ticket): string {
  return blocker.workspace === from.workspace
    ? `#${blocker.seq}`
    : `${blocker.workspace}#${blocker.seq}`;
}
