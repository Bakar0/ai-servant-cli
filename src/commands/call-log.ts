import { defineCommand } from "citty";
import { renderCallLog, writeCallLogHtml } from "../core/call-log/render.ts";
import {
  type CallLogSummary,
  listCallLogs,
  readCallLog,
  resolveCallLogId,
} from "../core/call-log/store.ts";
import { openInDefaultApp } from "../core/open.ts";
import { applyRootOverride } from "../core/paths.ts";

/** `2026-08-09 10:45` — enough to recognise a conversation by, without a column of seconds. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

function summaryLine(log: CallLogSummary): string {
  const parts = [
    `${log.utterances} turn${log.utterances === 1 ? "" : "s"}`,
    `${log.tools} tool call${log.tools === 1 ? "" : "s"}`,
  ];
  if (log.delegations > 0) parts.push(`${log.delegations} delegated`);
  if (log.handsCalls > 0) parts.push(`${log.handsCalls} hands`);
  if (log.steers > 0) parts.push(`${log.steers} steered`);
  if (!log.endReason) parts.push("cut off");
  return `  ${log.id.padEnd(34)}${when(log.startedAt)}  ${log.scope}  —  ${parts.join(", ")}`;
}

export const callLogCommand = defineCommand({
  meta: {
    name: "call-log",
    description:
      "Read back a past Summons: what each side said, every tool the agent called, every Delegation, and everything its Hands session did. With no argument, lists them; with one, renders a self-contained HTML page and opens it.",
  },
  args: {
    log: {
      type: "positional",
      required: false,
      description:
        "Which Summons: an id, enough of one to be unique, or `latest` (the default when opening).",
    },
    list: {
      type: "boolean",
      required: false,
      default: false,
      description: "List past Summonses and exit, even when one was named.",
    },
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Only Summonses of this workspace.",
    },
    json: {
      type: "boolean",
      required: false,
      default: false,
      description: "Print the record as JSON and exit; do not render/write/open HTML.",
    },
    "no-open": {
      type: "boolean",
      required: false,
      default: false,
      description: "Write the page and print its path, but don't open the browser.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const workspace = args.workspace as string | undefined;

    // Listing is the default because the id is a timestamp nobody remembers — the point of the
    // command is reaching a past Summons without knowing where its file lives.
    if (args.list || !args.log) {
      const logs = await listCallLogs({ workspace });
      if (logs.length === 0) {
        console.log("servant: no Call logs yet — nothing has been summoned.");
        return;
      }
      console.log(`servant: ${logs.length} Call log(s), newest first:`);
      for (const log of logs) console.log(summaryLine(log));
      console.log("\n  servant call-log <id>   opens one; `latest` opens the most recent.");
      return;
    }

    const resolved = await resolveCallLogId(args.log, { workspace });
    if ("error" in resolved) throw new Error(`servant call-log: ${resolved.error}`);
    const contents = await readCallLog(resolved.id);
    if (!contents) throw new Error(`servant call-log: could not read "${resolved.id}".`);

    if (args.json) {
      console.log(JSON.stringify(contents, null, 2));
      return;
    }

    const path = await writeCallLogHtml(resolved.id, renderCallLog(contents));
    if (!args["no-open"]) openInDefaultApp(path);
    console.log(path);
  },
});
