import {
  BoxRenderable,
  type CliRenderer,
  type CliRendererConfig,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import { NARRATE_HINT, type NarrationScreen, followTo, narrationAction } from "./narrate-view.ts";
import type { NarrationAction } from "./narrate-view.ts";

// The terminal the Player is drawn in: one adapter over `@opentui/core`, used imperatively. What a
// key *means* is next door in `narrate-view.ts` and has no terminal anywhere near it.
//
// `alternate-screen`, unlike the Summons — and the difference is the point. A Summons prints a
// conversation that has to survive hanging up, so it owns a footer and leaves the scrollback alone
// (workspace ADR 0014). A Player shows one live thing, the Ear-copy under a moving position, which
// is redrawn several times a second and is worthless the moment the Narration is over. Printing it
// into scrollback would leave hundreds of near-identical frames behind.
//
// The mouse is left alone here too: select-and-copy of the Ear-copy is worth more than anything
// mouse tracking would add.

const STATUS_HEIGHT = 1;
const HINT_HEIGHT = 1;
const MUTED_TEXT = "#8a8a8a";

export const NARRATE_RENDERER_CONFIG: CliRendererConfig = {
  screenMode: "alternate-screen",
  // Ctrl-C is a quit, which means releasing the lock and killing `sox`. Exiting from under both
  // would leave a lockfile nobody holds and, briefly, a voice with nothing driving it.
  exitOnCtrlC: false,
  useMouse: false,
  consoleMode: "disabled",
};

export interface NarrationTerminal {
  screen: NarrationScreen;
  /** Start sending keys somewhere, once there is a view built on this terminal's screen. */
  attach(onAction: (action: NarrationAction) => void): void;
  close(): void;
  width(): number;
}

export function openNarrationTerminal(): Promise<NarrationTerminal> {
  return createCliRenderer(NARRATE_RENDERER_CONFIG).then(mountNarrationTerminal);
}

export function mountNarrationTerminal(renderer: CliRenderer): NarrationTerminal {
  const root = new BoxRenderable(renderer, {
    id: "narrate-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });

  const status = new BoxRenderable(renderer, {
    id: "narrate-status",
    width: "100%",
    height: STATUS_HEIGHT,
    flexDirection: "row",
    justifyContent: "space-between",
  });
  // Two halves, and the layout puts the right one against the right edge — so a resize needs no
  // arithmetic in the view model, which has no idea how wide the window is.
  const title = new TextRenderable(renderer, { id: "narrate-title", content: "" });
  const playing = new TextRenderable(renderer, { id: "narrate-playing", content: "" });
  status.add(title);
  status.add(playing);

  // Scrolls, because a long Turn's Ear-copy is longer than the window and the live position walks
  // down it. Followed automatically below.
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "narrate-body",
    width: "100%",
    flexGrow: 1,
  });
  const body = new TextRenderable(renderer, { id: "narrate-text", content: "" });
  scroll.add(body);

  const hint = new TextRenderable(renderer, {
    id: "narrate-hint",
    content: NARRATE_HINT,
    height: HINT_HEIGHT,
    fg: MUTED_TEXT,
  });

  root.add(status);
  root.add(scroll);
  root.add(hint);
  renderer.root.add(root);

  let onAction: ((action: NarrationAction) => void) | undefined;
  const onKey = (key: { name?: string; ctrl?: boolean }): void => {
    const action = narrationAction(key);
    if (action && onAction) onAction(action);
  };
  renderer.keyInput.on("keypress", onKey);

  const screen: NarrationScreen = {
    body(lines) {
      body.content = lines.join("\n");
      const follow = followTo(lines);
      if (follow !== null) scroll.scrollTop = follow;
    },
    status(left, right) {
      title.content = left;
      playing.content = right;
    },
  };

  let closed = false;
  return {
    screen,
    attach(next) {
      onAction = next;
    },
    width: () => renderer.terminalWidth,
    close() {
      if (closed) return;
      closed = true;
      renderer.keyInput.off("keypress", onKey);
      renderer.destroy();
    },
  };
}
