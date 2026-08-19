import type { TicketAction } from "./store.ts";

/** The three kinds that describe a board-state transition, in no particular order. */
const HISTORY_KINDS = ["created", "status", "labels"] as const;

export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface HistoryEntry {
  kind: HistoryKind;
  /** The value the ticket moved to: a status, the whole new label set, or "" for `created`. */
  detail: string;
  at: string;
  /**
   * Who wrote it. "servant" is the default and names nobody; the hub importer writes "import", which
   * is how a transition carried in from GitHub is told apart from one this board made.
   *
   * No `session` beside it, unlike a comment: `createTicket` and `updateTicket` record an actor and
   * no session, so which session moved a ticket is not something the board knows. A null field here
   * would read as "no session was involved" when the truth is that none was recorded.
   */
  actor: string;
}

/**
 * A ticket's board-state transitions, oldest first — the answer to "how did this card get here?".
 *
 * Filtered here rather than by widening `ticketActions`, so the three readers that want only
 * comments keep the projection they already have. Claim transitions are deliberately absent even
 * though they are transitions: `servant claim --history` renders those, and a panel that repeated
 * them under a second heading would be two surfaces free to disagree about one trail.
 */
export function ticketHistory(actions: readonly TicketAction[]): HistoryEntry[] {
  const isHistory = (action: TicketAction): action is TicketAction & { kind: HistoryKind } =>
    (HISTORY_KINDS as readonly string[]).includes(action.kind);
  return actions.filter(isHistory).map((action) => ({
    kind: action.kind,
    detail: action.body,
    at: action.at,
    actor: action.actor,
  }));
}
