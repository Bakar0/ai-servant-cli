// What the Player's screen says and what its keys do, with no renderer anywhere. The screen is the
// audit trail for a Narration — the Ear-copy actually spoken and every Cue announced — so what it
// leaves out matters as much as what it shows.

import { describe, expect, test } from "bun:test";
import type { PlayerState } from "../src/core/narrate-player.ts";
import {
  clock,
  createNarrationView,
  formatNarrationStatus,
  formatNarrationTitle,
  followTo,
  narrationAction,
  renderNarration,
} from "../src/core/narrate-view.ts";
import type { NarrationTransport } from "../src/core/narrate-view.ts";

function state(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    segments: [],
    position: { segment: 0, offset: 0 },
    positionMs: 0,
    totalMs: 0,
    playing: true,
    tempo: 1,
    halted: null,
    synthesized: true,
    finished: false,
    ...overrides,
  };
}

function segment(index: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    index,
    kind: "prose" as const,
    text,
    cues: [],
    startsAtMs: 0,
    notice: null,
    ready: true,
    ...extra,
  };
}

describe("the keys", () => {
  test("the ticket's layout, key for key", () => {
    const pressed = (name: string) => narrationAction({ name });
    expect(pressed("space")).toBe("toggle");
    expect(pressed("left")).toBe("back");
    expect(pressed("right")).toBe("forward");
    expect(pressed("j")).toBe("next");
    expect(pressed("k")).toBe("prev");
    expect(pressed("[")).toBe("slower");
    expect(pressed("]")).toBe("faster");
    expect(pressed("r")).toBe("retry");
    expect(pressed("q")).toBe("quit");
  });

  test("ctrl-c quits, and no other chord means anything", () => {
    expect(narrationAction({ name: "c", ctrl: true })).toBe("quit");
    expect(narrationAction({ name: "j", ctrl: true })).toBeNull();
    expect(narrationAction({ name: "z" })).toBeNull();
  });

  test("each key reaches the Transport it names", () => {
    const called: string[] = [];
    const transport = new Proxy({} as NarrationTransport, {
      get: (_target, name: string) => () => {
        called.push(name);
      },
    });
    const view = createNarrationView({
      screen: { body: () => {}, status: () => {} },
      transport,
      title: { sessionId: "abcdef12", turn: 0, prompt: "go" },
    });
    for (const action of [
      "toggle",
      "back",
      "forward",
      "next",
      "prev",
      "slower",
      "faster",
      "retry",
      "quit",
    ] as const) {
      view.key(action);
    }
    expect(called).toEqual([
      "toggle",
      "back",
      "forward",
      "nextSegment",
      "prevSegment",
      "slower",
      "faster",
      "retry",
      "stop",
    ]);
  });
});

describe("the status line", () => {
  test("says where it is and how fast", () => {
    expect(formatNarrationStatus(state({ positionMs: 83_000, totalMs: 305_000, tempo: 1.2 }))).toBe(
      "▶ playing   1:23 / 5:05   1.2×",
    );
  });

  test("a pause while the rewrite is still running says so", () => {
    expect(formatNarrationStatus(state({ playing: false, synthesized: false }))).toContain(
      "still writing",
    );
  });

  test("a halt says why, where the eye already is", () => {
    const halted = "segment 4 failed to synthesize (500) — press r";
    expect(formatNarrationStatus(state({ halted }))).toContain(halted);
  });

  test("minutes and seconds, zero-padded", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(7_400)).toBe("0:07");
    expect(clock(605_000)).toBe("10:05");
  });

  test("the title names the session, so narrating the wrong one is visible", () => {
    expect(formatNarrationTitle({ sessionId: "abcdef12-3456", turn: 2, prompt: "why?" })).toBe(
      "narrating turn 3 of abcdef12 · why?",
    );
  });
});

describe("the Ear-copy on screen", () => {
  test("the Segment being spoken is marked", () => {
    const lines = renderNarration(
      state({
        segments: [segment(0, "First."), segment(1, "Second.")],
        position: { segment: 1, offset: 0 },
      }),
    );
    expect(lines.find((line) => line.includes("Second."))?.startsWith("▸")).toBe(true);
    expect(lines.find((line) => line.includes("First."))?.startsWith("▸")).toBe(false);
  });

  test("every Cue is under the Segment that skipped it, in reading order", () => {
    const lines = renderNarration(
      state({
        segments: [
          segment(0, "There's a table and a code block here.", {
            cues: [
              { node: "table", fate: "describe", say: "a table of timings", source: "" },
              { node: "code", fate: "describe", say: "a shell command", source: "" },
            ],
          }),
        ],
      }),
    );
    expect(lines.filter((line) => line.includes("↳"))).toEqual([
      "         ↳ a table of timings",
      "         ↳ a shell command",
    ]);
  });

  test("a Cue with nothing to say is decoration and is not shown", () => {
    const lines = renderNarration(
      state({
        segments: [
          segment(0, "Prose.", {
            cues: [{ node: "emoji", fate: "drop", say: "", source: "✅" }],
          }),
        ],
      }),
    );
    expect(lines.some((line) => line.includes("↳"))).toBe(false);
  });

  test("a Segment carrying a notice shows it, rather than only the status line", () => {
    const lines = renderNarration(
      state({ segments: [segment(0, "Cue only.", { notice: "segment 0 leaked a path" })] }),
    );
    expect(lines.some((line) => line.includes("⚠ segment 0 leaked a path"))).toBe(true);
  });

  test("a Segment with no audio yet reads as pending rather than as empty", () => {
    const lines = renderNarration(state({ segments: [segment(0, "", { ready: false })] }));
    expect(lines[0]).toContain("…");
  });

  test("each Segment carries the time it starts at", () => {
    const lines = renderNarration(
      state({
        segments: [
          segment(0, "First.", { startsAtMs: 0 }),
          segment(1, "Second.", { startsAtMs: 64_000 }),
        ],
      }),
    );
    expect(lines.find((line) => line.includes("Second."))).toContain("1:04");
  });

  test("the screen follows the position, keeping a line or two of lead-in above it", () => {
    const lines = ["  0:00  one", "  0:04  two", "  0:09  three", "▸ 0:14  four", "  0:20  five"];
    expect(followTo(lines)).toBe(1);
  });

  test("a position at the very top does not scroll off the beginning", () => {
    expect(followTo(["▸ 0:00  one", "  0:04  two"])).toBe(0);
  });

  test("nothing marked leaves the scroll where the reader put it", () => {
    expect(followTo(["  0:00  one", "  0:04  two"])).toBeNull();
  });

  test("long Ear-copy wraps instead of running off the window", () => {
    const long = "word ".repeat(60).trim();
    const lines = renderNarration(state({ segments: [segment(0, long)] }), 40);
    expect(lines.length).toBeGreaterThan(3);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(40);
  });
});
