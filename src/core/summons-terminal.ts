// The terminal the Summons view is drawn in: one adapter over `@opentui/core`, used imperatively.
//
// Everything here is rendering. What a key *means* is next door in `summons-view.ts`, driven through
// two ports and tested without a terminal — so this file has no decisions in it and stays the thin
// edge it looks like (workspace ADR 0014).
//
// Three choices below are the ADR, and undoing any of them undoes the reason the view is worth
// having:
//
//   - `main-screen`/`split-footer`, never `alternate-screen`. The transcript is *printed* into the
//     terminal's own scrollback, so it is still there — selectable, greppable, scrollable with the
//     scrollbar the user already has — after the Summons hangs up. OpenTUI owns the footer alone.
//   - `capture-stdout`, so printing is `process.stdout.write` of the same lines the Plain view
//     writes. The renderer splices them in above the footer; there is no second formatter.
//   - the mouse is left alone. Mouse tracking would take click-drag away from the terminal, and
//     select-and-copy of what was said is half of why the transcript lives in scrollback at all.

import {
  BoxRenderable,
  type CliRenderer,
  type CliRendererConfig,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import type { SummonsScreen } from "./summons-view.ts";
import { SUMMONS_VIEW_HINT } from "./summons-view.ts";

/** What the view does with a keystroke. The adapter's whole vocabulary. */
export interface SummonsKeyboard {
  submit(line: string): Promise<void>;
  escape(): void;
  toggleMute(): void;
  hangUp(): void;
  history(direction: "back" | "forward", current: string): void;
}

export interface SummonsTerminal {
  screen: SummonsScreen;
  /**
   * Start sending keys somewhere. Apart from opening, because the view that answers keys is built
   * *on* this terminal's screen — so one of the two has to exist first, and it is this one.
   */
  attach(keyboard: SummonsKeyboard): void;
  /** Hand the terminal back: the footer goes, the scrollback stays. */
  close(): void;
}

const STATUS_ROW = 1;
const INPUT_BOX = 3;
const HINT_ROW = 1;

/** Dim enough to read as furniture rather than as something that happened. */
const MUTED_TEXT = "#8a8a8a";

/**
 * Exported so a test can build its renderer the same way this does. The screen mode and the output
 * mode are the two settings the whole view rests on, and a test that quietly used different ones
 * would be testing a different view.
 */
export const SUMMONS_RENDERER_CONFIG: CliRendererConfig = {
  screenMode: "split-footer",
  footerHeight: STATUS_ROW + INPUT_BOX + HINT_ROW,
  externalOutputMode: "capture-stdout",
  // Ctrl-C is a hang-up, which means ending the Summons properly — closing the socket, ending the
  // Hands session, and writing the last line of the Call log. Exiting from under all that would
  // leave a headless session belonging to nobody.
  exitOnCtrlC: false,
  // The footer is the only thing that is cleared. Clearing the screen would take the conversation
  // with it, which is the one thing this view exists not to do.
  clearOnShutdown: false,
  useMouse: false,
  consoleMode: "disabled",
};

export function openSummonsTerminal(): Promise<SummonsTerminal> {
  return createCliRenderer(SUMMONS_RENDERER_CONFIG).then(mountSummonsTerminal);
}

/**
 * The footer, over a renderer someone else made — which is how a test gets to drive it.
 *
 * `out` has to be the very stream the renderer was handed, because `capture-stdout` works by
 * replacing *that* stream's `write`. Writing to any other one prints straight over the footer.
 */
export function mountSummonsTerminal(
  renderer: CliRenderer,
  out: { write(text: string): unknown } = process.stdout,
): SummonsTerminal {
  const footer = new BoxRenderable(renderer, {
    id: "summons-footer",
    width: "100%",
    flexDirection: "column",
  });
  const statusRow = new BoxRenderable(renderer, {
    id: "summons-status",
    width: "100%",
    height: STATUS_ROW,
    flexDirection: "row",
    justifyContent: "space-between",
  });
  // Two halves and let the layout put the right one against the right edge, so a resize needs no
  // arithmetic anywhere — least of all in the view model, which has no idea how wide the window is.
  const title = new TextRenderable(renderer, { id: "summons-title", content: "" });
  const state = new TextRenderable(renderer, { id: "summons-mic", content: "" });
  statusRow.add(title);
  statusRow.add(state);

  const inputBox = new BoxRenderable(renderer, {
    id: "summons-input-box",
    width: "100%",
    height: INPUT_BOX,
    border: true,
  });
  const input = new InputRenderable(renderer, {
    id: "summons-input",
    width: "100%",
    placeholder: "say something, or /help",
  });
  inputBox.add(input);

  const hint = new TextRenderable(renderer, {
    id: "summons-hint",
    content: SUMMONS_VIEW_HINT,
    fg: MUTED_TEXT,
  });

  footer.add(statusRow);
  footer.add(inputBox);
  footer.add(hint);
  renderer.root.add(footer);
  input.focus();

  /** Nothing to answer keys with until `attach`; the input still edits its own line meanwhile. */
  let keyboard: SummonsKeyboard | undefined;

  // One handler for the keys that are about the *session* rather than about the line being typed.
  // The input keeps every other key, including the ones it uses for line editing, so word-delete,
  // home, end, undo and paste are OpenTUI's and not reimplemented here.
  const onKey = (key: { name?: string; ctrl?: boolean }): void => {
    if (!keyboard) return;
    if (key.ctrl && key.name === "c") {
      keyboard.hangUp();
      return;
    }
    // `m` was the mic key while the terminal read two keys and dropped the rest; every letter is
    // part of an utterance now. See MUTE_KEY_HINT.
    if (key.ctrl && key.name === "t") {
      keyboard.toggleMute();
      return;
    }
    if (key.name === "escape") {
      keyboard.escape();
      return;
    }
    if (key.name === "up" || key.name === "down") {
      keyboard.history(key.name === "up" ? "back" : "forward", input.value);
    }
  };
  renderer.keyInput.on("keypress", onKey);
  input.on(InputRenderableEvents.ENTER, (line: string) => void keyboard?.submit(line));

  const screen: SummonsScreen = {
    // The terminal's own scrollback, through the stdout the renderer is intercepting.
    print(lines) {
      if (lines.length > 0) out.write(`${lines.join("\n")}\n`);
    },
    status(left, right) {
      title.content = left;
      state.content = right;
    },
    setInput(text) {
      input.value = text;
    },
  };

  let closed = false;
  return {
    screen,
    attach(next) {
      keyboard = next;
    },
    close() {
      if (closed) return;
      closed = true;
      renderer.keyInput.off("keypress", onKey);
      renderer.destroy();
    },
  };
}
