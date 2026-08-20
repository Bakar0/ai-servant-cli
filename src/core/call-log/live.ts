// The Plain view: the same entries the record gets, one line each, for a Summons whose output is
// not a terminal.
//
// It is a bystander, and stays one. It only ever writes lines — it never reads stdin, never
// prompts, never asks for a keypress, and never touches the audio path. That is what makes it the
// right view for a pipe, a redirect and a test, which is now all it is for: someone at a keyboard
// gets the Summons view instead (workspace ADR 0014).
//
// `formatCallLogEntry` is shared with that view rather than reimplemented there. One line per entry
// is what both need, and two formatters would mean a Summons read back through a pipe and a Summons
// watched live disagreeing about what happened in it.

import { type CallLogEntry, type CallLogPort, redactFields } from "./record.ts";

/** Columns, chosen so a tool line reads as a table without any of them wrapping on a small window. */
const NAME_WIDTH = 13;
const TARGET_WIDTH = 38;

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** Speech arrives with newlines in it; one utterance is one line here. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `12ms` under a second, `4.2s` over it — the two questions being "instant?" and "how long?". */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return safe < 1000 ? `${Math.round(safe)}ms` : `${(safe / 1000).toFixed(1)}s`;
}

const INDENT = "       ";

function toolLine(symbol: string, name: string, target: string, trailer: string): string {
  return `${INDENT}${symbol} ${pad(name, NAME_WIDTH)}${pad(clip(target, TARGET_WIDTH), TARGET_WIDTH)}${trailer}`;
}

/** Exported so the view is asserted line by line, with no terminal anywhere near the test. */
export function formatCallLogEntry(entry: CallLogEntry): string[] {
  switch (entry.type) {
    case "said":
      // The one place `channel` is visible. A typed utterance was never heard, so it cannot have
      // been mis-transcribed — which is exactly what a reader wondering about a strange line needs
      // to know, and cannot recover from the words themselves.
      return [
        `${entry.who === "user" ? "you  " : "agent"}  ${entry.channel === "typed" ? "⌨" : "▸"} ${oneLine(entry.text)}`,
      ];
    case "tool": {
      const outcome =
        entry.outcome === "ok"
          ? formatDuration(entry.durationMs)
          : entry.outcome === "held"
            ? `held — waiting on a yes${entry.detail ? ` (${entry.detail})` : ""}`
            : `failed — ${entry.detail ?? "no reason given"}`;
      return [toolLine("⚙", entry.name, entry.target, outcome)];
    }
    case "gate": {
      const verdict =
        entry.verdict === "confirmed"
          ? "confirmed"
          : entry.verdict === "declined"
            ? // Not "nothing launched": the gate holds stops as well as delegations now, and a
              // declined stop launched nothing in a sense that reads as the opposite of the truth.
              "declined — nothing happened"
            : "unclear — nothing happened";
      return [
        toolLine("?", "confirm", `"${entry.label}"`, `${verdict} ← "${oneLine(entry.heard)}"`),
      ];
    }
    case "delegation": {
      const outcome =
        entry.status === "launched"
          ? `→ ${entry.session ?? "?"}`
          : entry.status === "queued"
            ? `queued behind ${entry.detail ?? "another task"}`
            : `failed — ${entry.detail ?? "no reason given"}`;
      return [toolLine("⇒", entry.mode, `"${entry.label}"`, outcome)];
    }
    // The one line written while something is still happening, so a long request is visibly
    // running rather than indistinguishable from the agent having gone quiet.
    case "hands-asked":
      return [toolLine("⚙", "hands", oneLine(entry.request), "working…")];
    case "hands": {
      const lines = [
        toolLine(
          "⚙",
          "hands",
          oneLine(entry.request),
          entry.outcome === "ok" ? formatDuration(entry.durationMs) : "failed",
        ),
      ];
      if (entry.response) lines.push(`${INDENT}  ↳ ${clip(oneLine(entry.response), 72)}`);
      return lines;
    }
    case "steer-sent":
      return [toolLine("→", "steer", `${entry.target}: ${oneLine(entry.instruction)}`, "sending…")];
    case "steer": {
      const outcome =
        entry.status === "delivered"
          ? `delivered — applied at its next safe point (${formatDuration(entry.durationMs)})`
          : entry.status === "unconfirmed"
            ? "UNCONFIRMED — the relay did not say it sent it"
            : `failed — ${entry.detail ?? "no reason given"}`;
      return [
        toolLine(
          "→",
          entry.stop ? "stop" : "steer",
          `${entry.target}: ${oneLine(entry.instruction)}`,
          outcome,
        ),
      ];
    }
    case "note":
      return [`${INDENT}${entry.level === "error" ? "!" : "·"} ${oneLine(entry.text)}`];
    case "ended":
      return [`${INDENT}— Summons ended (${entry.reason})`];
  }
  // Add an entry kind without giving it a line and this is where the compiler says so — silently
  // rendering nothing is the one failure a live view must not have.
  entry satisfies never;
  return [];
}

export interface LiveCallLogOptions {
  /** Where a formatted line goes. Injected so the view is tested without a real terminal. */
  write: (line: string) => void;
}

/** Redacts on its own account: what scrolls past is as public as what is kept. */
export function createLiveCallLogView(opts: LiveCallLogOptions): CallLogPort {
  return {
    record(entry) {
      for (const line of formatCallLogEntry(redactFields(entry))) opts.write(line);
    },
  };
}
