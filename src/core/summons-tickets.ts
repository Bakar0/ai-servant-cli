// The outside of the tickets seam: the hub reads and writes steering needs, behind `gh`.
//
// It exists so the controller can enforce Claim scoping deterministically (workspace ADR 0010,
// decision 9 as amended) without the controller knowing anything about `gh` — the same shape as
// the delegation and hands seams.

import { $ } from "bun";
import { type ClaimGhRunner, readClaimResult } from "./claims.ts";
import type { TicketsPort } from "./summons.ts";

export interface SummonsTicketsDeps {
  hubRepo: string;
  /** Injected in tests, so nothing here shells out to a real `gh`. */
  ghRunner?: ClaimGhRunner | undefined;
}

export function createSummonsTickets(deps: SummonsTicketsDeps): TicketsPort {
  const opts = deps.ghRunner ? { ghRunner: deps.ghRunner } : {};
  return {
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
