// The outside of the tickets seam: the board reads and writes a Summons performs.
//
// It exists so the controller can enforce Claim scoping deterministically (workspace ADR 0010,
// decision 9 as amended) without the controller knowing anything about the store — the same shape
// as the delegation and hands seams. There is no runner to inject any more: the board is a local
// file, and the test seam is the servant-root override (ADR-0011).

import { addComment, createTicket } from "./board/store.ts";
import { readClaimResult } from "./claims.ts";
import type { TicketFilingPort, TicketsPort } from "./summons.ts";

export interface SummonsTicketsDeps {
  /** Which workspace's board a filed ticket joins. Membership is structural now, not a label. */
  workspace: string;
  /**
   * The Call log this Summons is writing, named in the body of anything it files. A ticket that
   * arrived by voice is the one kind whose reasoning is not in the thread that produced it, so it
   * carries the way back to the conversation instead.
   */
  callLogId?: string | undefined;
}

/** Stamped on a ticket a Summons filed, so servant can tell its own writes apart from a human's. */
export const SUMMONS_TICKET_MARKER = "<!-- servant:summons -->";

function composeBody(deps: SummonsTicketsDeps, body: string): string {
  const provenance = deps.callLogId
    ? `Filed by voice from a Summons on \`${deps.workspace}\`. Read the conversation back with \`servant call-log ${deps.callLogId}\`.`
    : `Filed by voice from a Summons on \`${deps.workspace}\`.`;
  return `${body.trim()}\n\n---\n${SUMMONS_TICKET_MARKER}\n${provenance}\n`;
}

export function createSummonsTickets(deps: SummonsTicketsDeps): TicketsPort & TicketFilingPort {
  return {
    async file({ title, body }) {
      const ticket = createTicket({
        workspace: deps.workspace,
        title,
        body: composeBody(deps, body),
      });
      return { number: ticket.seq, url: ticket.url };
    },

    async claim(ticket) {
      const result = await readClaimResult(deps.workspace, ticket);
      if (!result.known) return { known: false };
      return { known: true, session: result.claim?.session ?? null };
    },

    async comment(ticket, body) {
      addComment({ workspace: deps.workspace, seq: ticket }, body);
    },
  };
}
