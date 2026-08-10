// Reading a past Summons back reuses the machinery `servant dashboard` and insights --deep already
// use — one shipped template with a single JSON slot (see `html-artifact.ts`), filled here. The
// renderer adds no markup of its own, so what the page looks like is a question for the template.

import { mkdir } from "node:fs/promises";
import { fillDataSlot } from "../html-artifact.ts";
import { callLogHtmlPath, callLogRenderedDir } from "../paths.ts";
import type { CallLogContents, CallLogSummary } from "./store.ts";
import { CALL_LOG_TEMPLATE } from "./template.ts";

/** The exact sentinel the template carries in its `<script type="application/json">` data slot. */
const DATA_SLOT = "__CALL_LOG_DATA__";

export interface CallLogViewData {
  summary: CallLogSummary & { durationMs: number | null };
  entries: CallLogContents["records"];
}

/**
 * Joins the parts of a pairing key. A separator no part can contain, so "steer at b" and
 * "steer a tb" cannot collide — an instruction is free text and a session name is not.
 */
const SEP = "\u0000";

/**
 * Drop the "asked" half of every round trip that came back — reading a Summons afterwards, the
 * answer row says everything the question row did. What survives is a request no answer ever
 * followed, which is the one case reading it back cannot otherwise show: a Summons killed while
 * its Hands session was still working.
 *
 * Paired on the request text, not on position. Two requests can be in flight at once, and a
 * request that failed before it was ever sent records an answer with no question in front of it —
 * either way "the next answer after a question" pairs the wrong two, and the casualty is exactly
 * the still-running request this exists to keep.
 */
function withoutAnsweredRequests(records: CallLogContents["records"]): CallLogContents["records"] {
  const answered = new Set<number>();
  const waiting = new Map<string, number[]>();
  // The two round trips that record their asking separately. A steer is keyed on the session as
  // well as the words, since the same instruction really does go to two sessions.
  const keyOf = (record: CallLogContents["records"][number]): string | null => {
    if (record.type === "hands-asked" || record.type === "hands")
      return `hands${SEP}${record.request}`;
    if (record.type === "steer-sent" || record.type === "steer") {
      return `steer${SEP}${record.target}${SEP}${record.instruction}`;
    }
    return null;
  };
  records.forEach((record, at) => {
    const key = keyOf(record);
    if (key === null) return;
    if (record.type === "hands-asked" || record.type === "steer-sent") {
      waiting.set(key, [...(waiting.get(key) ?? []), at]);
      return;
    }
    // Oldest first: asked the same thing twice, the first answer belongs to the first question.
    const asked = waiting.get(key)?.shift();
    if (asked !== undefined) answered.add(asked);
  });
  return records.filter((_record, at) => !answered.has(at));
}

/** Derived from the record and nothing else, so the page has no second source of truth. */
export function buildCallLogViewData(contents: CallLogContents): CallLogViewData {
  const { summary } = contents;
  const records = withoutAnsweredRequests(contents.records);
  const started = Date.parse(summary.startedAt);
  const ended = summary.endedAt ? Date.parse(summary.endedAt) : Number.NaN;
  const durationMs =
    Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
  return { summary: { ...summary, durationMs }, entries: records };
}

/** Self-contained and offline: the returned page references no network resource. */
export function renderCallLog(contents: CallLogContents): string {
  return fillDataSlot(CALL_LOG_TEMPLATE, DATA_SLOT, buildCallLogViewData(contents));
}

/** Written beside the records but apart from them — a regenerated artifact, not a data record. */
export async function writeCallLogHtml(id: string, html: string): Promise<string> {
  await mkdir(callLogRenderedDir(), { recursive: true });
  const path = callLogHtmlPath(id);
  await Bun.write(path, html);
  return path;
}
