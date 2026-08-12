// The keyboard side of a live Summons, against a fake stdin — no terminal, no raw mode.

import { describe, expect, test } from "bun:test";
import { type KeyInput, attachKeyControls, keyAction } from "../src/core/summons-keys.ts";

function fakeInput(isTTY = true) {
  const listeners: ((chunk: string) => void)[] = [];
  const state = { raw: [] as boolean[], resumed: 0, paused: 0 };
  const input: KeyInput = {
    isTTY,
    setRawMode(mode) {
      state.raw.push(mode);
    },
    setEncoding() {},
    resume() {
      state.resumed += 1;
    },
    pause() {
      state.paused += 1;
    },
    on(_event, listener) {
      listeners.push(listener);
    },
    off(_event, listener) {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  return { input, state, press: (key: string) => listeners.forEach((l) => l(key)) };
}

describe("what a keystroke means", () => {
  test("m toggles the mic, in either case", () => {
    expect(keyAction("m")).toBe("toggle-mute");
    expect(keyAction("M")).toBe("toggle-mute");
  });

  // Raw mode is what makes single keypresses readable, and it stops the terminal raising SIGINT —
  // so the documented way to hang up only keeps working if this is handled here.
  test("Ctrl-C still hangs up, because raw mode means nothing else will", () => {
    expect(keyAction("\u0003")).toBe("hang-up");
    expect(keyAction("\u0004")).toBe("hang-up");
  });

  test("anything else is left alone — the keyboard is not the interface", () => {
    expect(keyAction("a")).toBeNull();
    expect(keyAction("\r")).toBeNull();
    expect(keyAction(" ")).toBeNull();
  });
});

describe("the controls a live Summons attaches", () => {
  function build(isTTY = true) {
    const { input, state, press } = fakeInput(isTTY);
    const reported: string[] = [];
    let muted = false;
    let hungUp = 0;
    const detach = attachKeyControls({
      input,
      toggleMute: () => (muted = !muted),
      hangUp: () => {
        hungUp += 1;
      },
      report: (message) => reported.push(message),
    });
    return { state, press, reported, detach, muted: () => muted, hungUp: () => hungUp };
  }

  test("pressing m mutes and says so, and pressing it again unmutes", () => {
    const keys = build();

    keys.press("m");
    expect(keys.muted()).toBe(true);
    expect(keys.reported[0]).toContain("muted");

    keys.press("m");
    expect(keys.muted()).toBe(false);
    expect(keys.reported[1]).toContain("unmuted");
  });

  test("Ctrl-C hangs the session up", () => {
    const keys = build();

    keys.press("\u0003");

    expect(keys.hungUp()).toBe(1);
  });

  test("the terminal is handed back however the session ends", () => {
    const keys = build();
    expect(keys.state.raw).toEqual([true]);

    keys.detach();

    expect(keys.state.raw).toEqual([true, false]);
    expect(keys.state.paused).toBe(1);
    // And a second release is harmless — stopping twice is normal for a session that ends itself.
    keys.detach();
    expect(keys.state.raw).toEqual([true, false]);
  });

  test("detached keys are dead keys", () => {
    const keys = build();

    keys.detach();
    keys.press("m");

    expect(keys.muted()).toBe(false);
  });

  test("stdin that is not a terminal is left completely alone", () => {
    const keys = build(false);

    expect(keys.state.raw).toEqual([]);
    expect(keys.state.resumed).toBe(0);
    keys.press("m");
    expect(keys.muted()).toBe(false);
  });
});
