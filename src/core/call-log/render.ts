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

/** Derived from the record and nothing else, so the page has no second source of truth. */
export function buildCallLogViewData(contents: CallLogContents): CallLogViewData {
  const { summary, records } = contents;
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
