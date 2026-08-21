// The Summons view, minus the terminal.
//
// Everything about the interactive view that is a decision rather than a rendering: what a key
// means, what a slash command does, what the status line says, and what `/tool 7` prints. The
// terminal itself is one thin adapter (`summons-terminal.ts`) over the two ports below, so the
// whole of the view's behaviour is testable with no renderer, no TTY and no native library
// anywhere near a test — which is the only way this much interaction stays honest.
//
// The transcript is *printed*, into the terminal's own scrollback, and never re-rendered: the
// terminal owns scrolling, selection and search, and OpenTUI owns only the footer (workspace
// ADR 0014). That is also why `/tool 7` prints the call again below rather than expanding a row in
// place — there is no row to expand, because the rows are terminal history.

import { formatCallLogEntry, formatToolOutcome } from "./call-log/live.ts";
import { type CallLogEntry, type CallLogPort, redactFields } from "./call-log/record.ts";
import type { SummonsDelegationStatus, SummonsStatus } from "./summons.ts";

/**
 * The terminal, as the view needs it. Three operations, and the middle one takes its two halves
 * apart rather than a laid-out line: the right edge moves with the window, and a view model that
 * padded to a width would be a view model that has to be told when the window is resized.
 */
export interface SummonsScreen {
  /** Print into the terminal's own scrollback, above the pinned footer. */
  print(lines: readonly string[]): void;
  /** Replace the status line: what this Summons is, and what it is doing. */
  status(left: string, right: string): void;
  /** Replace the delegated-work row. Empty when nothing has been handed to a Claude session. */
  work(text: string): void;
  /** Replace what is on the input line — after sending, walking history, and clearing with `Esc`. */
  setInput(text: string): void;
}

/** The session, as the view needs it — the four things a keyboard can do to a Summons. */
export interface SummonsViewSession {
  typed(text: string): Promise<void>;
  /** Answers whether there was a reply to cut off, which is what gives `Esc` its second meaning. */
  interrupt(): boolean;
  toggleMute(): boolean;
  stop(): Promise<void>;
}

export interface SummonsViewOptions {
  screen: SummonsScreen;
  session: SummonsViewSession;
  workspace: string;
  /**
   * The mounted repo the conversation is narrowed to, if it is. Empty for a Summons over the whole
   * workspace, which is the ordinary case and does not need saying twice.
   */
  scope: string;
  /** False under `--no-barge-in`. Said on the status line, since a room where nothing can be talked over reads as broken. */
  bargeIn?: boolean | undefined;
  /** Where to read a past Summons back — printed when a tool call has scrolled out of memory. */
  callLogId?: string | undefined;
}

/**
 * The mic key is `^T`, and it used to be `m`.
 *
 * `m` was right while the terminal read exactly two keys and every other keystroke was thrown away.
 * Now every letter is a character in an utterance, so a mic on `m` would mute the Summons the first
 * time someone typed "maybe" — and a mic on "`m` when the line happens to be empty" is worse,
 * because it is invisible. So it moved to a chord no message can contain, and to `/mute` for anyone
 * who would rather say it in words than remember it.
 */
export const MUTE_KEY_HINT = "^T";

/** The line under the input box. Every control the view has, since none of them are guessable. */
export const SUMMONS_VIEW_HINT = `${MUTE_KEY_HINT} mute · esc interrupt · ↑ history · enter send · ^C hang up · /help`;

/**
 * How many tool calls `/tool N` can still reach. A Summons is a live conversation and its args and
 * results are capped at 4k each, so this is a bounded few megabytes rather than a buffer that grows
 * for as long as the session runs. Past it the answer is not "no such call" but where to read it:
 * the Call log has every one of them, in full, on disk.
 */
export const TOOL_DETAIL_MEMORY = 200;

const DETAIL_INDENT = "         ";

/** `1.4k` over a thousand, `840` under it — the status line is glanced at, not read. */
function level(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(Math.round(value));
}

/** `4s`, `12s`, `2m` — coarse on purpose, since the question is "is it stuck?" and not "how long". */
function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/**
 * What the Summons is doing, as the right-hand end of the status line: what it is up to, then what
 * the mic is hearing. Both, always, because they answer different questions — a Summons can be
 * muted and thinking at once, and a line that showed one of them would be wrong half the time.
 *
 * The level and the floor are here for the reason servant-summon#3 exists: the echo detector's
 * thresholds are a heuristic against a real room, and nobody can tune them without watching the two
 * numbers while talking over a reply. Muted shows neither, because a muted mic is heard by nobody
 * however loud the room gets, and a moving number would say otherwise.
 */
export function formatSummonsStatus(status: SummonsStatus): string {
  const doing =
    status.doing === "working"
      ? `⚙ ${status.tool ?? "working"} ${elapsed(status.forMs)}`
      : status.doing === "thinking"
        ? `◐ thinking ${elapsed(status.forMs)}`
        : status.doing === "speaking"
          ? "▶ speaking"
          : "● listening";
  const mic = status.muted
    ? "◼ muted"
    : `${level(status.level)} / floor ${status.floor === null ? "—" : level(status.floor)}`;
  return `${doing}   ${mic}`;
}

/** The left-hand end: what this Summons is. Fixed for its whole life, so it is composed once. */
export function formatSummonsTitle(opts: {
  workspace: string;
  scope: string;
  bargeIn?: boolean | undefined;
}): string {
  const parts = [`servant summon · ${opts.workspace}`];
  if (opts.scope && opts.scope !== opts.workspace) parts.push(opts.scope);
  if (opts.bargeIn === false) parts.push("barge-in off");
  return parts.join(" · ");
}

/** Indent a block of text under its label, so a multi-line result still reads as one field. */
function block(label: string, text: string): string[] {
  const pretty = prettyJson(text);
  const [first = "", ...rest] = pretty.split("\n");
  return [
    `${DETAIL_INDENT}${label} ${first}`,
    ...rest.map((line) => `${DETAIL_INDENT}${" ".repeat(label.length)} ${line}`),
  ];
}

/** Tool args and results are JSON on the wire. Unfolded when it is, printed as-is when it is not. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

type ToolEntry = Extract<CallLogEntry, { type: "tool" }>;

/**
 * One tool call, in full.
 *
 * `result` is absent for the tools that answer their own call — `delegate`, `research`,
 * `steer_session`, `stop_session`, `file_ticket`. Each of those leaves a richer entry of its own a
 * line below (a `delegation`, a `steer`, a `gate`), so what it answered is already on screen and in
 * the record; threading a copy of it out through ~20 return sites would buy the view a second
 * version of something it can already see. So this says where the answer is instead.
 */
export function formatToolDetail(entry: ToolEntry): string[] {
  const head = `${DETAIL_INDENT}tool ${entry.number} · ${entry.name}${entry.target ? ` · ${entry.target}` : ""} · ${formatToolOutcome(entry)}`;
  const lines = [head];
  if (entry.args) lines.push(...block("args  ", entry.args));
  if (entry.result !== undefined) lines.push(...block("result", entry.result));
  else if (entry.outcome === "ok") {
    lines.push(
      `${DETAIL_INDENT}result answered itself — what it did is the line below it in the transcript`,
    );
  }
  return lines;
}

/**
 * What has been handed to Claude sessions, on one row.
 *
 * The "am I still connected to it" question, and a glance is the right size of answer — a Summons
 * used to launch a session and then know nothing about it until somebody thought to ask. Empty when
 * nothing has been delegated, which is most Summonses.
 */
export function formatDelegationRow(delegations: readonly SummonsDelegationStatus[]): string {
  if (delegations.length === 0) return "";
  const one = (d: SummonsDelegationStatus) => {
    const where = d.session ? ` → ${d.session}` : "";
    // A finished session's age says nothing useful; a running one's is the whole question.
    const age = d.state === "running" || d.state === "unknown" ? ` ${elapsed(d.forMs)}` : "";
    return `${d.label}${where}  ${d.state}${age}`;
  };
  return `⇒ ${delegations.map(one).join("  ·  ")}`;
}

const HELP: readonly string[] = [
  "  the Summons view",
  "    enter          send what you typed, as an ordinary turn — the answer comes back in voice",
  `    ${MUTE_KEY_HINT}, /mute      mute or unmute the mic. Typing never touches it either way`,
  "    esc            cut the reply off; with nothing playing, clear the input line",
  "    ↑ ↓            back and forward through what you have typed",
  "    /tool N        print tool call N in full — its arguments and what came back",
  "    /help          this",
  "    ^C, /quit      hang up",
];

export interface SummonsView extends CallLogPort {
  /**
   * Enter, with whatever was on the input line.
   *
   * One line, and enter sends it — the input is deliberately not multiline. An Utterance is one
   * turn in a conversation held out loud, and enter-sends is what makes typing one feel like saying
   * it; a paragraph composed over several lines would need a second key to send, which is a
   * different kind of interface than the one a Summons is. A pasted block arrives as one line with
   * its newlines stripped, so pasting something long still sends as the one turn it is.
   */
  submit(line: string): Promise<void>;
  /** `Esc` — two things, and which one depends on whether there is a reply to cut off. */
  escape(): void;
  /** The mic chord. */
  toggleMute(): void;
  /** `Ctrl-C`. */
  hangUp(): void;
  /** Up and down, with whatever is on the line now so a half-typed draft survives the trip. */
  history(direction: "back" | "forward", current: string): void;
  /** What the Summons reports about itself, straight onto the status line. */
  status(status: SummonsStatus): void;
  /** Anything the command itself has to say: the banner, `--debug`, a dying speaker. */
  say(text: string): void;
}

export function createSummonsView(opts: SummonsViewOptions): SummonsView {
  const title = formatSummonsTitle(opts);
  const tools = new Map<number, ToolEntry>();
  /** What has been typed, oldest first — and only what was typed, since nothing else was. */
  const typed: string[] = [];
  /**
   * Where `↑` has walked back to. `typed.length` is the draft the user was in the middle of, which
   * is why it is kept apart: walking back and forward again has to end where it started, or history
   * eats the sentence it was asked to leave alone.
   */
  let at = 0;
  let draft = "";

  const print = (lines: readonly string[]) => opts.screen.print(lines);
  const say = (text: string) => print([`       · ${text}`]);

  function showStatus(status: SummonsStatus): void {
    opts.screen.status(title, formatSummonsStatus(status));
    opts.screen.work(formatDelegationRow(status.delegations));
  }

  function showTool(argument: string): void {
    const number = Number(argument);
    if (!Number.isInteger(number) || number <= 0) {
      say(`/tool wants a call number — "${argument}" is not one.`);
      return;
    }
    const entry = tools.get(number);
    if (entry) {
      print(formatToolDetail(entry));
      return;
    }
    const seen = tools.size === 0 ? 0 : Math.max(...tools.keys());
    if (number > seen) {
      say(`No tool call ${number} yet — ${seen} so far this Summons.`);
      return;
    }
    // Older than the view keeps. The record has it, so the answer is where, not "gone".
    say(
      `Tool call ${number} has scrolled out of the view.` +
        (opts.callLogId ? ` Read it back with: servant call-log ${opts.callLogId}` : ""),
    );
  }

  /**
   * Run a slash command. Every line reaching here starts with a slash, so there is no "not a
   * command" answer to give back — an unrecognised one is a typo, and a typo said out loud to the
   * agent is worse than a typo refused. So it is refused, and the words are left on the input line
   * for the user to fix rather than swallowed.
   */
  function command(line: string): void {
    const [word = "", ...rest] = line.split(/\s+/);
    const argument = rest.join(" ");
    switch (word) {
      case "/tool":
        showTool(argument);
        return;
      case "/mute":
        opts.session.toggleMute();
        return;
      case "/help":
        print(HELP);
        return;
      case "/quit":
        void opts.session.stop();
        return;
      default:
        say(`No such command: ${word}. /help lists them.`);
        opts.screen.setInput(line);
    }
  }

  // Drawn once before anything has happened, so the Summons says what it is from the moment it
  // opens. Waiting for the first mic frame would leave the line blank exactly when a mic that never
  // started is the thing the user is trying to diagnose.
  showStatus({
    muted: false,
    doing: "listening",
    forMs: 0,
    level: 0,
    floor: null,
    delegations: [],
  });

  return {
    record(entry) {
      const clean = redactFields(entry);
      if (clean.type === "tool" && clean.number !== undefined) {
        tools.set(clean.number, clean);
        // Bounded from the front: the oldest call is the one least likely to be asked about, and
        // the Call log still has it whole.
        for (const number of tools.keys()) {
          if (tools.size <= TOOL_DETAIL_MEMORY) break;
          tools.delete(number);
        }
      }
      print(formatCallLogEntry(clean));
    },

    async submit(line) {
      const utterance = line.trim();
      if (!utterance) return;
      // History remembers the line whatever it turns out to be — a mistyped command is exactly the
      // thing worth getting back with one keypress.
      if (typed.at(-1) !== utterance) typed.push(utterance);
      at = typed.length;
      draft = "";
      if (utterance.startsWith("/")) {
        // Cleared first, so a command that puts something back on the line (an unknown one) wins.
        opts.screen.setInput("");
        command(utterance);
        return;
      }
      opts.screen.setInput("");
      await opts.session.typed(utterance);
    },

    escape() {
      // The reply first: with the agent talking, `Esc` means stop — and the draft on the input line
      // is worth more than a keystroke, so it survives an interruption rather than being cleared
      // alongside it.
      if (opts.session.interrupt()) return;
      opts.screen.setInput("");
      at = typed.length;
      draft = "";
    },

    toggleMute() {
      opts.session.toggleMute();
    },

    hangUp() {
      void opts.session.stop();
    },

    history(direction, current) {
      if (typed.length === 0) return;
      if (at === typed.length) draft = current;
      at =
        direction === "back"
          ? Math.max(0, at - 1)
          : // Forward past the newest entry is the draft again, never a wrap-around: history is a
            // list to walk out of, not a ring to be trapped in.
            Math.min(typed.length, at + 1);
      opts.screen.setInput(at === typed.length ? draft : (typed[at] ?? ""));
    },

    status: showStatus,

    say,
  };
}
