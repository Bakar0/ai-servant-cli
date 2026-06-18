import { defineCommand } from "citty";
import { recordHookEvent } from "../core/insights/events.ts";
import { applyRootOverride } from "../core/paths.ts";

// `servant record` is the telemetry sink: every Claude Code hook in a servant workspace pipes its
// stdin payload into it (wired by `ensureWorkspaceSettings`). It reads the payload, enriches it
// from the transcript, and appends an event to the session's log. It is on the hot path — it runs
// on every tool call — so it must be fast and, above all, NEVER fail the session: PreToolUse and
// UserPromptSubmit treat a non-zero exit as a block, so we swallow everything and exit 0.

export const recordCommand = defineCommand({
  meta: {
    name: "record",
    description:
      "Telemetry sink for Claude Code hooks: reads a hook payload on stdin and records one session event. Wired automatically per workspace; not meant to be run by hand.",
  },
  args: {
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
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
