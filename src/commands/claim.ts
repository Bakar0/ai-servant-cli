import { defineCommand } from "citty";
import { claimTicket, releaseTicketClaim } from "../core/claims.ts";
import { requireInit } from "../core/config.ts";
import { applyRootOverride } from "../core/paths.ts";

function parseTicket(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("servant claim: <ticket> must be a hub issue number.");
  }
  return n;
}

export const claimCommand = defineCommand({
  meta: {
    name: "claim",
    description:
      "Record which session is carrying a hub ticket, or release it when the work is done. A Claim is written as part of spawning; this is how the session that holds one hands it back.",
  },
  args: {
    ticket: {
      type: "positional",
      required: true,
      description: "Hub issue number.",
    },
    session: {
      type: "string",
      required: false,
      description: "Session name taking or releasing the Claim (e.g. ai-servant-t17).",
    },
    release: {
      type: "boolean",
      required: false,
      default: false,
      description: "Release the Claim instead of taking it.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const { hubRepo } = await requireInit();
    const ticket = parseTicket(args.ticket);

    const session = args.session?.trim();
    if (!session) throw new Error("servant claim: --session <name> is required.");

    if (args.release) {
      await releaseTicketClaim(hubRepo, ticket, session);
      console.log(`servant: released the Claim on #${ticket} held by "${session}"`);
      return;
    }

    const { transferredFrom, alreadyHeld } = await claimTicket(hubRepo, ticket, session);
    if (alreadyHeld) console.log(`servant: #${ticket} was already claimed by "${session}"`);
    else if (transferredFrom) {
      console.log(
        `servant: moved the Claim on #${ticket} from "${transferredFrom}" to "${session}"`,
      );
    } else console.log(`servant: claimed #${ticket} for "${session}"`);
  },
});
