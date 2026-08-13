import { defineCommand } from "citty";
import { parseSeq, resolveBoardWorkspace } from "../core/board/address.ts";
import { claimHistory, claimTicket, releaseTicketClaim } from "../core/claims.ts";
import { applyRootOverride } from "../core/paths.ts";

export const claimCommand = defineCommand({
  meta: {
    name: "claim",
    description:
      "Record which session is carrying a board ticket, or release it when the work is done. The voice delegation path writes a Claim as it spawns; everywhere else — /servant:handoff reclaiming a stale one, a session releasing its own — goes through this command.",
  },
  args: {
    ticket: {
      type: "positional",
      required: true,
      description: "Ticket number on the board.",
    },
    session: {
      type: "string",
      required: false,
      description: "Session name taking or releasing the Claim (e.g. ai-servant-t17).",
    },
    ws: {
      type: "string",
      required: false,
      description:
        "Which workspace's board the ticket is on. Defaults to the one the session name encodes, then to the current workspace.",
    },
    release: {
      type: "boolean",
      required: false,
      default: false,
      description: "Release the Claim instead of taking it.",
    },
    history: {
      type: "boolean",
      required: false,
      default: false,
      description: "Print the ticket's claim history instead of changing anything.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant claim");
    const session = args.session?.trim();
    const workspace = await resolveBoardWorkspace({ ws: args.ws, session, seq });

    if (args.history) {
      const history = await claimHistory(workspace, seq);
      console.log(`servant: claim history for ${workspace}#${seq}\n`);
      if (history.length === 0) console.log("  none — nobody has ever held it.");
      for (const record of history) {
        const from = record.from ? ` (from "${record.from}")` : "";
        console.log(`  ${record.at}  ${record.kind}  "${record.session}"${from}`);
      }
      return;
    }

    if (!session) throw new Error("servant claim: --session <name> is required.");

    if (args.release) {
      await releaseTicketClaim(workspace, seq, session);
      console.log(`servant: released the Claim on ${workspace}#${seq} held by "${session}"`);
      return;
    }

    const { transferredFrom, alreadyHeld } = await claimTicket(workspace, seq, session);
    if (alreadyHeld) {
      console.log(`servant: ${workspace}#${seq} was already claimed by "${session}"`);
    } else if (transferredFrom) {
      console.log(
        `servant: moved the Claim on ${workspace}#${seq} from "${transferredFrom}" to "${session}"`,
      );
    } else console.log(`servant: claimed ${workspace}#${seq} for "${session}"`);
  },
});
