import type { PlayerState } from "./narrate-player.ts";

// The Player's screen, minus the terminal.
//
// What a key means and what the screen says, decided here and driven through one port, so all of it
// is testable with no renderer and no TTY — the same split the Summons view uses (workspace ADR
// 0014), and for the same reason.
//
// The screen is not decoration. A Narration is a rewrite of what is on the screen, spoken by a model
// that was asked not to read certain things out; the only way to know it did the job is to be able
// to look at what it decided to say and at every skip it announced. That is what this shows, against
// a live position, which is also how you find the paragraph you want to hear again.

/** Every control there is. None of them are guessable, so all of them are on screen. */
export const NARRATE_HINT = "space pause · ← → 5s · j k segment · [ ] tempo · r retry · q quit";

export interface NarrationScreen {
  /** Replace the body: the Ear-copy, with the live position and every Cue. */
  body(lines: readonly string[]): void;
  /** Replace the two ends of the status line. */
  status(left: string, right: string): void;
}

/** The Player, as the keyboard needs it. */
export interface NarrationTransport {
  toggle(): void;
  back(): void;
  forward(): void;
  nextSegment(): void;
  prevSegment(): void;
  slower(): void;
  faster(): void;
  retry(): void;
  stop(): Promise<void>;
}

export type NarrationAction =
  | "toggle"
  | "back"
  | "forward"
  | "next"
  | "prev"
  | "slower"
  | "faster"
  | "retry"
  | "quit";

/**
 * A keystroke as a Transport action.
 *
 * The arrows are the ±5s keys and `j`/`k` are the Segment keys, which is the ticket's layout — and
 * it is worth keeping the two on different kinds of key: they move by different units, and a
 * listener who has to remember which arrow is which unit has a Transport they cannot use blind.
 */
export function narrationAction(key: { name?: string; ctrl?: boolean }): NarrationAction | null {
  if (key.ctrl && key.name === "c") return "quit";
  if (key.ctrl) return null;
  switch (key.name) {
    case "space":
      return "toggle";
    case "left":
      return "back";
    case "right":
      return "forward";
    case "j":
      return "next";
    case "k":
      return "prev";
    case "[":
      return "slower";
    case "]":
      return "faster";
    case "r":
      return "retry";
    case "q":
      return "quit";
    default:
      return null;
  }
}

/** What `followTo` looks for, and what the eye looks for. One place, so they cannot disagree. */
const POSITION_MARKER = "▸";

/** `0:07`, `1:23`, `12:04`. Minutes and seconds, because a Narration is minutes long, not hours. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The right-hand end of the status line: what it is doing, where it is, and how fast.
 *
 * A halt says why on this line, in the place the eye already goes, because the alternative — a
 * Narration that has simply gone quiet — is the failure this feature is least able to afford.
 */
export function formatNarrationStatus(state: PlayerState): string {
  const where = `${clock(state.positionMs)} / ${clock(state.totalMs)}`;
  const rate = `${state.tempo.toFixed(1)}×`;
  if (state.halted) return `⚠ ${state.halted}   ${where}`;
  const doing = state.finished
    ? "■ end"
    : state.playing
      ? "▶ playing"
      : state.synthesized
        ? "⏸ paused"
        : "⏸ paused, still writing";
  return `${doing}   ${where}   ${rate}`;
}

export interface NarrationTitle {
  sessionId: string;
  turn: number;
  prompt: string;
}

/** The left-hand end: which session and which Turn, since picking the wrong one is silent otherwise. */
export function formatNarrationTitle(title: NarrationTitle): string {
  const asked = title.prompt.length > 60 ? `${title.prompt.slice(0, 59)}…` : title.prompt;
  return `narrating turn ${title.turn + 1} of ${title.sessionId.slice(0, 8)} · ${asked}`;
}

/**
 * The Ear-copy, as lines, with the live position marked and every Cue under the Segment it came
 * from. Cues arrive in reading order as of #1's `c42fbce`, so they are shown in the order they were
 * passed over and not sorted here.
 */
export function renderNarration(state: PlayerState, width = 80): string[] {
  const lines: string[] = [];
  const wrapAt = Math.max(24, width - 12);

  for (const segment of state.segments) {
    const here = segment.index === state.position.segment;
    const marker = here ? POSITION_MARKER : " ";
    const heading = segment.kind === "beat";
    const text = segment.text || (segment.ready ? "" : "…");
    const [first = "", ...rest] = wrap(heading ? text.toUpperCase() : text, wrapAt);

    lines.push(`${marker} ${clock(segment.startsAtMs).padStart(5)}  ${first}`);
    for (const line of rest) lines.push(`${" ".repeat(9)}${line}`);
    for (const cue of segment.cues) {
      if (!cue.say) continue;
      lines.push(`${" ".repeat(9)}↳ ${cue.say}`);
    }
    if (segment.notice) lines.push(`${" ".repeat(9)}⚠ ${segment.notice}`);
    lines.push("");
  }
  return lines;
}

function wrap(text: string, width: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Where the body should be scrolled to, given the lines it now shows: two lines above the one the
 * position is on, or nowhere when nothing is marked.
 *
 * Here rather than in the terminal because it is a decision — the reason to look at this screen at
 * all is to see where the voice has got to, so the screen follows the voice instead of asking the
 * listener to chase it. Null means leave the scroll where the reader put it.
 */
export function followTo(lines: readonly string[]): number | null {
  const marked = lines.findIndex((line) => line.startsWith(POSITION_MARKER));
  return marked < 0 ? null : Math.max(0, marked - 2);
}

export interface NarrationViewOptions {
  screen: NarrationScreen;
  transport: NarrationTransport;
  title: NarrationTitle;
  width?: () => number;
}

export interface NarrationView {
  /** A keystroke, already turned into an action by the terminal adapter. */
  key(action: NarrationAction): void;
  /** New state from the Player. */
  update(state: PlayerState): void;
}

export function createNarrationView(options: NarrationViewOptions): NarrationView {
  const left = formatNarrationTitle(options.title);
  return {
    key(action) {
      const transport = options.transport;
      switch (action) {
        case "toggle":
          return transport.toggle();
        case "back":
          return transport.back();
        case "forward":
          return transport.forward();
        case "next":
          return transport.nextSegment();
        case "prev":
          return transport.prevSegment();
        case "slower":
          return transport.slower();
        case "faster":
          return transport.faster();
        case "retry":
          return transport.retry();
        case "quit":
          void transport.stop();
          return;
      }
    },
    update(state) {
      options.screen.body(renderNarration(state, options.width?.() ?? 80));
      options.screen.status(left, formatNarrationStatus(state));
    },
  };
}
