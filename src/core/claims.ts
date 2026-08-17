// A Claim: the record saying which session is carrying a ticket, and since when.
//
// It lives on the board (ADR-0011 decision 2, superseding ADR-0010 decision 2) as an assignment
// field plus an append-only action row. ADR-0010 argued a Claim must be on the ticket because "a
// local file would be invisible in exactly the moment it matters" — that objection is about
// visibility, not locality, and a live board is more visible than an issue comment.
//
// The semantics carry over from ADR-0010 unchanged: the most recent record wins, a release
// supersedes a hold, re-claiming a ticket you already hold is a no-op, and a transfer is explicit.
// The action row is kept for a *different* reason than ADR-0010 gave: the assignment field can hold
// the session name directly now, so the log exists for transfer history and audit.

import {
  type Claim,
  findTicket,
  requireTicket,
  ticketActions,
  updateClaim,
} from "./board/store.ts";

export type { Claim } from "./board/store.ts";

export interface ClaimOptions {
  /** ISO timestamp to stamp the record with; injected so tests don't depend on the clock. */
  now?: string | undefined;
}

// These stay `async` over a synchronous store because they are a *seam*: `summons-delegate` injects
// them (`typeof claimTicket`) and composes the release with `.catch()`, so the Promise-returning
// shape is what the delegation path is written against.

/**
 * A ticket's Claim, keeping "we could not look" apart from "nobody holds it".
 *
 * Most callers do not need the difference — a spawn that cannot read the board claims anyway.
 * Steering does: it is scoped to sessions holding a Claim, and a scope that reads a ticket it
 * cannot find as an unclaimed ticket is not a scope at all (ADR-0010 decision 9). A local database
 * answers far more often than a remote hub did, which makes this distinction *easier* to forget —
 * ADR-0011 keeps it deliberately.
 */
export type ClaimResult = { known: false } | { known: true; claim: Claim | null };

/**
 * `known: false` covers both ways this can fail to answer — the board could not be opened, and there
 * is no such ticket on that board. They are one answer here because the question is "who is carrying
 * *this ticket*", and neither case has one: reporting a mistyped number as an unclaimed ticket would
 * hand a caller a Claim decision about work that does not exist.
 */
export async function readClaimResult(workspace: string, seq: number): Promise<ClaimResult> {
  try {
    const ticket = findTicket(workspace, seq);
    if (!ticket) return { known: false };
    return { known: true, claim: ticket.claim };
  } catch {
    return { known: false };
  }
}

/** The Claim, with an unreadable ticket flattened to "no claim known" — never a hard stop. */
export async function readClaim(workspace: string, seq: number): Promise<Claim | null> {
  const result = await readClaimResult(workspace, seq);
  return result.known ? result.claim : null;
}

/**
 * Take (or transfer) the Claim on a ticket. Idempotent: a ticket already held by this same session
 * is left alone, so a retried spawn neither restamps the hold nor litters the history.
 */
export async function claimTicket(
  workspace: string,
  seq: number,
  session: string,
  opts: ClaimOptions = {},
): Promise<{ transferredFrom: string | null; alreadyHeld: boolean }> {
  const ticket = requireTicket(workspace, seq);
  const at = opts.now ?? new Date().toISOString();
  if (ticket.claim?.session === session) return { transferredFrom: null, alreadyHeld: true };
  const previous = ticket.claim?.session ?? null;
  updateClaim(ticket, { session, at });
  return { transferredFrom: previous, alreadyHeld: false };
}

/** Release the Claim, so `servant tasks --frontier` stops reporting the ticket as in flight. */
export async function releaseTicketClaim(
  workspace: string,
  seq: number,
  session: string,
  opts: ClaimOptions = {},
): Promise<void> {
  const at = opts.now ?? new Date().toISOString();
  updateClaim({ workspace, seq }, null, { session, now: at });
}

export interface ClaimRecord {
  kind: "claimed" | "transferred" | "released";
  session: string;
  at: string;
  /** The session a transfer took it from, when that is what happened. */
  from: string | null;
}

const CLAIM_KINDS = new Set(["claimed", "transferred", "released"]);

/** The full claim history — who held it, when, and what happened to it. */
export async function claimHistory(workspace: string, seq: number): Promise<ClaimRecord[]> {
  // findTicket, not an address: this is asked speculatively, of numbers a caller may have typed,
  // and a ticket that is not there is no history rather than an error.
  const ticket = findTicket(workspace, seq);
  if (!ticket) return [];
  return ticketActions(ticket)
    .filter((action) => CLAIM_KINDS.has(action.kind))
    .map((action) => ({
      kind: action.kind as ClaimRecord["kind"],
      session: action.session ?? "",
      at: action.at,
      from: action.kind === "transferred" ? action.body || null : null,
    }));
}
