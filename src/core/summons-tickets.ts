// The outside of the tickets seam: the hub reads and writes steering needs, behind `gh`.
//
// It exists so the controller can enforce Claim scoping deterministically (workspace ADR 0010,
// decision 9 as amended) without the controller knowing anything about `gh` — the same shape as
// the delegation and hands seams.

import { $ } from "bun";
import { type ClaimGhRunner, readClaimResult } from "./claims.ts";
import { WS_LABEL_PREFIX } from "./tasks.ts";
import type { TicketFilingPort, TicketsPort } from "./summons.ts";

export interface SummonsTicketsDeps {
  hubRepo: string;
  /** Which workspace's backlog a filed ticket joins — the `ws:` label `servant tasks` groups on. */
  workspace: string;
  /**
   * The Call log this Summons is writing, named in the body of anything it files. A ticket that
   * arrived by voice is the one kind whose reasoning is not in the thread that produced it, so it
   * carries the way back to the conversation instead.
   */
  callLogId?: string | undefined;
  /** Injected in tests, so nothing here shells out to a real `gh`. */
  ghRunner?: ClaimGhRunner | undefined;
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
  const opts = deps.ghRunner ? { ghRunner: deps.ghRunner } : {};
  return {
    async file({ title, body }) {
      const runner = deps.ghRunner ?? defaultTicketRunner;
      const out = await runner([
        "issue",
        "create",
        "--repo",
        deps.hubRepo,
        "--label",
        `${WS_LABEL_PREFIX}${deps.workspace}`,
        "--title",
        title,
        "--body",
        composeBody(deps, body),
      ]);
      // `gh` answers with the new issue's URL. No URL means no number the agent could say out loud,
      // and a spoken "filed it" pointing at nothing is worse than an outright failure.
      const match = /(https?:\/\/\S*?\/issues\/(\d+))/.exec(out);
      if (!match) {
        throw new Error(`could not tell from gh whether the ticket was filed: ${out.trim()}`);
      }
      return { number: Number(match[2]), url: match[1] as string };
    },

    async claim(ticket) {
      const result = await readClaimResult(deps.hubRepo, ticket, opts);
      if (!result.known) return { known: false };
      // A released Claim is a ticket nobody is carrying, not a ticket whose last carrier is still
      // reachable — so it reports as unclaimed and steering refuses.
      return {
        known: true,
        session: result.claim?.kind === "held" ? result.claim.session : null,
      };
    },

    async comment(ticket, body) {
      const runner = deps.ghRunner ?? defaultTicketRunner;
      await runner(["issue", "comment", String(ticket), "--repo", deps.hubRepo, "--body", body]);
    },
  };
}

const defaultTicketRunner: ClaimGhRunner = async (args) => {
  const res = await $`gh ${args}`.nothrow().quiet();
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.toString().trim() || `gh ${args.join(" ")} failed`);
  }
  return res.stdout.toString();
};
