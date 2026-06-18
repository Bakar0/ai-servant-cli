import { defineCommand } from "citty";
import { recordHookEvent } from "../core/insights/events.ts";
import {
  type ReconcileResult,
  reconcileAllSessions,
  reconcileSessionById,
} from "../core/insights/reconcile.ts";
import { applyRootOverride } from "../core/paths.ts";

// `servant record` is the telemetry sink: every Claude Code hook in a servant workspace pipes its
// stdin payload into it (wired by `ensureWorkspaceSettings`). It reads the payload, enriches it
// from the transcript, and appends an event to the session's log. It is on the hot path — it runs
// on every tool call — so it must be fast and, above all, NEVER fail the session: PreToolUse and
// UserPromptSubmit treat a non-zero exit as a block, so we swallow everything and exit 0.
//
// `--reconcile` is the one mode meant to be run by hand: a maintenance pass that backfills the
// lossy live log from the transcript (see core/insights/reconcile.ts). It reports normally and is
// reached before the stdin read, so the hook path (which never passes flags) is untouched.

const RECONCILE_DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function describe(r: ReconcileResult): string {
  const mode = r.hadLog ? "gap-filled" : "reconstructed";
  const breakdown = Object.entries(r.byType)
    .map(([t, n]) => `${t}: ${n}`)
    .join(", ");
  const head = `${r.sessionId}: +${r.appended} events (${mode})${breakdown ? ` — ${breakdown}` : ""}`;
  if (r.discrepancies.length === 0) return head;
  const shown = r.discrepancies
    .slice(0, 5)
    .map((d) => `    ⚠ turn ${d.turnId} ${d.field}: live ${d.live} ≠ transcript ${d.transcript}`)
    .join("\n");
  const more = r.discrepancies.length > 5 ? `\n    … and ${r.discrepancies.length - 5} more` : "";
  return `${head}\n  ${r.discrepancies.length} ctx discrepancy(ies):\n${shown}${more}`;
}

async function runReconcile(args: {
  session?: string;
  all?: boolean;
  days?: string;
}): Promise<void> {
  if (args.session) {
    const result = await reconcileSessionById(args.session);
    if (!result) throw new Error(`No transcript found for session "${args.session}".`);
    console.log(describe(result));
    return;
  }
  if (!args.all) {
    throw new Error("servant record --reconcile needs --session <id> or --all.");
  }
  const days = Number.parseInt(args.days ?? "", 10);
  const n = Number.isFinite(days) && days > 0 ? days : RECONCILE_DEFAULT_DAYS;
  const results = await reconcileAllSessions(n * DAY_MS);
  const changed = results.filter((r) => r.appended > 0 || r.discrepancies.length > 0);
  for (const r of changed) console.log(describe(r));
  const appended = results.reduce((sum, r) => sum + r.appended, 0);
  const discrepancies = results.reduce((sum, r) => sum + r.discrepancies.length, 0);
  console.log(
    `\nReconciled ${results.length} session(s) (last ${n}d): +${appended} events, ${discrepancies} discrepancy(ies) across ${changed.length} changed.`,
  );
}

export const recordCommand = defineCommand({
  meta: {
    name: "record",
    description:
      "Telemetry sink for Claude Code hooks: reads a hook payload on stdin and records one session event. Wired automatically per workspace; not meant to be run by hand. Use --reconcile to backfill the live log from transcripts.",
  },
  args: {
    reconcile: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Maintenance pass: backfill the live event log from transcripts (see --session/--all).",
    },
    session: {
      type: "string",
      required: false,
      alias: "s",
      description: "With --reconcile: the session id to reconcile.",
    },
    all: {
      type: "boolean",
      required: false,
      default: false,
      description: "With --reconcile: reconcile every servant session in the window.",
    },
    days: {
      type: "string",
      required: false,
      description: `With --reconcile --all: rolling window in days (default: ${RECONCILE_DEFAULT_DAYS}).`,
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);

    // Maintenance mode is reached before the stdin read; it reports errors normally.
    if (args.reconcile) {
      await runReconcile(args);
      return;
    }

    try {
      const stdin = await Bun.stdin.text();
      const payload = JSON.parse(stdin) as Record<string, unknown>;
      await recordHookEvent(payload);
    } catch {
      // Telemetry must never block a session. Malformed payload, unreadable transcript,
      // unwritable store — all are non-fatal; drop the event and exit clean.
    }
  },
});
