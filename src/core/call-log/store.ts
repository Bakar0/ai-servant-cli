// The Call log on disk: one append-only JSONL file per Summons in servant's own store.
//
// Append-only is the whole design. The record is written entry by entry as the conversation
// happens rather than assembled and flushed at the end, so killing a Summons mid-sentence still
// leaves everything up to that sentence — which is exactly the case the record exists for.

import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { callLogPath, callLogsRoot } from "../paths.ts";
import {
  type CallLogEndReason,
  type CallLogHeader,
  type CallLogPort,
  type CallLogRecord,
  redactFields,
} from "./record.ts";

function twoDigit(n: number): string {
  return String(n).padStart(2, "0");
}

/** `ai-servant-20260809-104512` — sortable, and says at a glance which Summons it was. */
export function callLogId(workspace: string, at: Date): string {
  const slug =
    workspace
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const stamp = `${at.getFullYear()}${twoDigit(at.getMonth() + 1)}${twoDigit(at.getDate())}-${twoDigit(at.getHours())}${twoDigit(at.getMinutes())}${twoDigit(at.getSeconds())}`;
  return `${slug}-${stamp}`;
}

export interface OpenCallLogOptions extends Omit<CallLogHeader, "id"> {
  /** Injected in tests, so a record's stamps are asserted rather than waited for. */
  now?: (() => Date) | undefined;
  /** Called if a write fails. Failing to record must never break the conversation being recorded. */
  onWriteError?: ((message: string) => void) | undefined;
}

export interface OpenCallLog {
  id: string;
  path: string;
  port: CallLogPort;
  /** Resolves once every queued append has landed. Call before reading the record back. */
  close(): Promise<void>;
}

/**
 * Start a Call log and hand back the port a Summons records through. This is the one part that can
 * throw — an unopenable record is a startup failure worth stopping for, in the same class as the
 * missing key and missing `sox` the command already refuses to start without.
 */
export async function openCallLog(opts: OpenCallLogOptions): Promise<OpenCallLog> {
  const now = opts.now ?? (() => new Date());
  await mkdir(callLogsRoot(), { recursive: true });

  const openedAt = now();
  const base = callLogId(opts.workspace, openedAt);
  // `wx` is the reservation: two Summonses opened in the same second would otherwise share a file
  // and interleave, and only the OS can settle that without a race.
  let id = base;
  let path = callLogPath(id);
  for (let n = 2; ; n++) {
    // Redacted like every other line: a scope label carries a repo name, and a repo name has been
    // known to carry a token.
    const header: CallLogRecord = redactFields({
      type: "opened",
      at: openedAt.toISOString(),
      id,
      workspace: opts.workspace,
      scope: opts.scope,
      model: opts.model,
      voice: opts.voice,
    });
    try {
      await writeFile(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      id = `${base}-${n}`;
      path = callLogPath(id);
    }
  }

  // Writes are serialized through one chain: appends stay in the order they were recorded, and a
  // slow disk queues behind itself instead of stalling the caller (see `CallLogPort`).
  let queue: Promise<void> = Promise.resolve();
  function append(record: CallLogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    queue = queue
      .then(() => appendFile(path, line))
      .catch((err: unknown) => {
        opts.onWriteError?.(err instanceof Error ? err.message : String(err));
      });
  }

  return {
    id,
    path,
    port: {
      record(entry) {
        append({ at: now().toISOString(), ...redactFields(entry) });
      },
    },
    close: () => queue,
  };
}

/** What a past Summons was, without reading every word of it. */
export interface CallLogSummary extends CallLogHeader {
  path: string;
  startedAt: string;
  /** null when the process died before it could say why it stopped. */
  endedAt: string | null;
  endReason: CallLogEndReason | null;
  utterances: number;
  tools: number;
  delegations: number;
  handsCalls: number;
  /** Instructions relayed to running sessions — delivered, unconfirmed and failed alike. */
  steers: number;
}

export interface CallLogContents {
  summary: CallLogSummary;
  records: CallLogRecord[];
}

/**
 * Parse a record file. A killed Summons leaves a half-written final line, so unparseable lines are
 * skipped rather than treated as corruption — losing the tail is the expected failure mode here.
 */
function parseRecords(text: string): CallLogRecord[] {
  const records: CallLogRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as CallLogRecord);
    } catch {
      // a torn trailing write
    }
  }
  return records;
}

function summarize(id: string, records: CallLogRecord[]): CallLogSummary | null {
  const opened = records.find((r) => r.type === "opened");
  if (!opened) return null;
  const ended = records.findLast((r) => r.type === "ended");
  const count = (type: CallLogRecord["type"]) => records.filter((r) => r.type === type).length;
  return {
    id: opened.id || id,
    workspace: opened.workspace,
    scope: opened.scope,
    model: opened.model,
    voice: opened.voice,
    path: callLogPath(id),
    startedAt: opened.at,
    endedAt: ended?.at ?? null,
    endReason: ended?.reason ?? null,
    utterances: count("said"),
    tools: count("tool"),
    delegations: count("delegation"),
    handsCalls: count("hands"),
    steers: count("steer"),
  };
}

/** Read one Call log in full, or null when there is no such record (or it has no header). */
export async function readCallLog(id: string): Promise<CallLogContents | null> {
  const file = Bun.file(callLogPath(id));
  if (!(await file.exists())) return null;
  const records = parseRecords(await file.text());
  const summary = summarize(id, records);
  return summary ? { summary, records } : null;
}

/** Every past Summons, newest first. Optionally narrowed to one workspace. */
export async function listCallLogs(
  opts: { workspace?: string | undefined } = {},
): Promise<CallLogSummary[]> {
  let names: string[];
  try {
    names = await readdir(callLogsRoot());
  } catch {
    return [];
  }
  const summaries: CallLogSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const contents = await readCallLog(name.slice(0, -".jsonl".length));
    if (!contents) continue;
    if (opts.workspace && contents.summary.workspace !== opts.workspace) continue;
    summaries.push(contents.summary);
  }
  return summaries.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Turn what a person would type into an id: `latest`, a full id, or enough of one to be unique.
 * The point is that a past Summons is reachable without knowing where its file lives.
 */
export async function resolveCallLogId(
  ref: string | undefined,
  opts: { workspace?: string | undefined } = {},
): Promise<{ id: string } | { error: string }> {
  const logs = await listCallLogs(opts);
  if (logs.length === 0) return { error: "No Call logs yet — nothing has been summoned." };
  if (!ref || ref === "latest") return { id: (logs[0] as CallLogSummary).id };

  const exact = logs.find((l) => l.id === ref);
  if (exact) return { id: exact.id };
  const partial = logs.filter((l) => l.id.includes(ref));
  if (partial.length === 1) return { id: (partial[0] as CallLogSummary).id };
  if (partial.length === 0) return { error: `No Call log matching "${ref}".` };
  return {
    error: `"${ref}" matches ${partial.length} Call logs: ${partial.map((l) => l.id).join(", ")}.`,
  };
}
