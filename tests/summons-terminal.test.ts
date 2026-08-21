// The Summons view's terminal, on OpenTUI's own test renderer: a real footer, a real key parser and
// a real frame, with no TTY. Thin on purpose — what a key *means* is tested in summons-view.test.ts,
// and this asserts only the wiring between the two: that a keystroke arrives as the right call, and
// that a printed line goes above the footer rather than into it.

import { afterEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createTestRenderer } from "@opentui/core/testing";
import {
  SUMMONS_RENDERER_CONFIG,
  type SummonsTerminal,
  mountSummonsTerminal,
} from "../src/core/summons-terminal.ts";

/**
 * A terminal-shaped sink. OpenTUI captures external output by replacing the `write` of the stream it
 * was handed, so the test has to own that stream to be able to print through it — and it has to
 * claim to be a TTY, since a renderer will not set up a terminal that is not one.
 */
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

let open: SummonsTerminal | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

async function mounted() {
  // The renderer's own stdout, ours to hand to both halves: `capture-stdout` splices in what is
  // written to the stream the renderer was given, so printing anywhere else would miss it.
  const stdout = new FakeStdout() as unknown as NodeJS.WriteStream;
  const setup = await createTestRenderer({
    ...SUMMONS_RENDERER_CONFIG,
    stdout,
    width: 60,
    height: 12,
    // A bare `Esc` is ambiguous on a plain terminal — it is also the first byte of every arrow key,
    // so a parser has to wait to see whether more is coming. The kitty protocol removes the
    // ambiguity, and it is what the renderer asks for wherever the terminal offers it.
    kittyKeyboard: true,
  });
  const terminal = mountSummonsTerminal(setup.renderer, stdout);
  open = terminal;
  const heard = {
    submitted: [] as string[],
    escapes: 0,
    mutes: 0,
    hangUps: 0,
    history: [] as { direction: string; current: string }[],
  };
  terminal.attach({
    async submit(line) {
      heard.submitted.push(line);
    },
    escape() {
      heard.escapes += 1;
    },
    toggleMute() {
      heard.mutes += 1;
    },
    hangUp() {
      heard.hangUps += 1;
    },
    history(direction, current) {
      heard.history.push({ direction, current });
    },
  });
  await setup.renderOnce();
  return { ...setup, terminal, heard };
}

describe("the Summons terminal", () => {
  test("pins a footer carrying the status line, the input and every control", async () => {
    const t = await mounted();
    t.terminal.screen.status("servant summon · ws", "● listening   1.4k / floor 900");
    await t.renderOnce();

    const frame = t.captureCharFrame();
    expect(frame).toContain("servant summon · ws");
    expect(frame).toContain("● listening");
    expect(frame).toContain("^T mute");
    expect(frame).toContain("say something, or /help");
  });

  test("delegated work gets its own row in the footer", async () => {
    const t = await mounted();

    t.terminal.screen.work("⇒ loadtest → summon-t3  running 4m");
    await t.renderOnce();

    expect(t.captureCharFrame()).toContain("loadtest → summon-t3");
  });

  test("enter hands the typed line over, once", async () => {
    const t = await mounted();

    await t.mockInput.typeText("check ticket 3");
    t.mockInput.pressEnter();
    await t.flush();

    expect(t.heard.submitted).toEqual(["check ticket 3"]);
  });

  // One key per test on purpose: fed back to back with no gap between them, an `Esc` and the key
  // after it arrive as one escape sequence — which is the terminal's own ambiguity, not the view's.
  test("esc reaches the view", async () => {
    const t = await mounted();

    t.mockInput.pressEscape();
    await t.flush();

    expect(t.heard.escapes).toBe(1);
  });

  test("the mic chord reaches the view, and is not a character in the line", async () => {
    const t = await mounted();

    t.mockInput.pressKey("t", { ctrl: true });
    t.mockInput.pressEnter();
    await t.flush();

    expect(t.heard.mutes).toBe(1);
    expect(t.heard.submitted).toEqual([""]);
  });

  test("Ctrl-C hangs up rather than killing the process out from under the Summons", async () => {
    const t = await mounted();

    t.mockInput.pressCtrlC();
    await t.flush();

    expect(t.heard.hangUps).toBe(1);
  });

  // The open question from the ticket, answered by the library: a pasted block arrives as one line
  // with its newlines stripped, so pasting a paragraph is one utterance rather than several turns.
  test("a pasted block is one line, not one turn per newline", async () => {
    const t = await mounted();

    await t.mockInput.pasteBracketedText("check ticket 3\nand ticket 4");
    t.mockInput.pressEnter();
    await t.flush();

    expect(t.heard.submitted).toEqual(["check ticket 3and ticket 4"]);
  });

  // The draft goes with the keypress: history has to put it back when the user walks forward out of
  // it again, and only the input knows what is on the line.
  test("up and down carry whatever is on the line with them", async () => {
    const t = await mounted();

    await t.mockInput.typeText("half a sen");
    t.mockInput.pressArrow("up");
    await t.flush();

    expect(t.heard.history).toEqual([{ direction: "back", current: "half a sen" }]);
  });

  test("what is printed goes into the scrollback above the footer, not into it", async () => {
    const t = await mounted();
    t.externalOutput.clear();

    t.terminal.screen.print(["you    ⌨ hello", "agent  ▸ hello yourself"]);
    await t.flush();

    const written = t.externalOutput.takeText();
    expect(written).toContain("you    ⌨ hello");
    expect(written).toContain("agent  ▸ hello yourself");
    // And not in the footer, which is the whole distinction: the terminal owns the transcript.
    expect(t.captureCharFrame()).not.toContain("hello yourself");
  });

  test("setInput replaces the line, which is what history and a refused command need", async () => {
    const t = await mounted();

    await t.mockInput.typeText("junk");
    t.terminal.screen.setInput("/tool 3");
    t.mockInput.pressEnter();
    await t.flush();

    expect(t.heard.submitted).toEqual(["/tool 3"]);
  });

  test("closing twice is harmless — a Summons that ends itself stops twice", async () => {
    const t = await mounted();

    t.terminal.close();
    expect(() => t.terminal.close()).not.toThrow();
  });
});
