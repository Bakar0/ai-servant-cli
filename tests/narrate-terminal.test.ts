// The Player's terminal, on OpenTUI's own test renderer: a real key parser and a real frame, with
// no TTY. Thin on purpose — what a key *means* is tested in narrate-view.test.ts, and this asserts
// only the wiring: that a keystroke arrives as the right action, and that the body follows the
// live position rather than making the listener chase it.

import { afterEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createTestRenderer } from "@opentui/core/testing";
import {
  NARRATE_RENDERER_CONFIG,
  type NarrationTerminal,
  mountNarrationTerminal,
} from "../src/core/narrate-terminal.ts";
import type { NarrationAction } from "../src/core/narrate-view.ts";

class FakeStdout extends Writable {
  readonly isTTY = true;
  readonly columns = 60;
  readonly rows = 12;
  override _write(_chunk: unknown, _encoding: unknown, done: () => void): void {
    done();
  }
  getColorDepth(): number {
    return 24;
  }
}

/** A keypress as the renderer's own event shape. Only the fields the adapter reads are filled. */
function press(key: { name: string; ctrl?: boolean }) {
  return { ctrl: false, meta: false, shift: false, ...key } as never;
}

let open: NarrationTerminal | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

async function mounted() {
  const stdout = new FakeStdout() as unknown as NodeJS.WriteStream;
  const setup = await createTestRenderer({
    ...NARRATE_RENDERER_CONFIG,
    stdout,
    width: 60,
    height: 12,
    // A bare `Esc` is ambiguous on a plain terminal, and the arrows the Transport uses all start
    // with one. The kitty protocol removes the ambiguity wherever the terminal offers it.
    kittyKeyboard: true,
  });
  const terminal = mountNarrationTerminal(setup.renderer);
  open = terminal;
  const actions: NarrationAction[] = [];
  terminal.attach((action) => actions.push(action));
  return { ...setup, terminal, actions };
}

describe("the Player's terminal", () => {
  test("a keystroke arrives as the action it means", async () => {
    const { renderer, actions } = await mounted();
    renderer.keyInput.emit("keypress", press({ name: "space" }));
    renderer.keyInput.emit("keypress", press({ name: "left" }));
    renderer.keyInput.emit("keypress", press({ name: "]" }));
    expect(actions).toEqual(["toggle", "back", "faster"]);
  });

  test("a key that means nothing is not passed on as something", async () => {
    const { renderer, actions } = await mounted();
    renderer.keyInput.emit("keypress", press({ name: "z" }));
    expect(actions).toEqual([]);
  });

  test("the Ear-copy it is handed is the Ear-copy on the screen", async () => {
    const { terminal, renderOnce, captureCharFrame } = await mounted();
    terminal.screen.status("narrating turn 1", "playing");
    terminal.screen.body(["▸ 0:30  the rewrite is streamed"]);
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("the rewrite is streamed");
    expect(frame).toContain("narrating turn 1");
    // The hint is on screen unasked, because none of the Transport keys are guessable.
    expect(frame).toContain("space pause");
  });

  test("it takes the alternate screen, and gives the terminal back on close", async () => {
    expect(NARRATE_RENDERER_CONFIG.screenMode).toBe("alternate-screen");
    // Ctrl-C has to reach the view: quitting means releasing the lock and killing `sox`, and
    // exiting from under both would leave a lockfile nobody holds.
    expect(NARRATE_RENDERER_CONFIG.exitOnCtrlC).toBe(false);
    const { terminal, actions, renderer } = await mounted();
    renderer.keyInput.emit("keypress", press({ name: "c", ctrl: true }));
    expect(actions).toEqual(["quit"]);
    terminal.close();
    terminal.close();
  });
});
