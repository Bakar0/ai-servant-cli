// The Summons view without a terminal: every key, command and status line driven through fake
// ports. No renderer, no TTY, no native library — which is the point of the view model existing
// apart from the adapter that draws it.

import { describe, expect, test } from "bun:test";
import type { CallLogEntry } from "../src/core/call-log/record.ts";
import {
  SUMMONS_VIEW_HINT,
  TOOL_DETAIL_MEMORY,
  createSummonsView,
  formatMicState,
  formatSummonsTitle,
} from "../src/core/summons-view.ts";
import type { SummonsViewSession } from "../src/core/summons-view.ts";
import type { SummonsMicState } from "../src/core/summons.ts";

function fakeSession(overrides: Partial<SummonsViewSession> = {}) {
  const state = { typed: [] as string[], interrupts: 0, mutes: 0, stops: 0, cutOff: true };
  const session: SummonsViewSession = {
    async typed(text) {
      state.typed.push(text);
    },
    interrupt() {
      state.interrupts += 1;
      return state.cutOff;
    },
    toggleMute() {
      state.mutes += 1;
      return state.mutes % 2 === 1;
    },
    async stop() {
      state.stops += 1;
    },
    ...overrides,
  };
  return { session, state };
}

function built(options: Partial<Parameters<typeof createSummonsView>[0]> = {}) {
  const { session, state } = fakeSession();
  const printed: string[] = [];
  const status: { left: string; right: string }[] = [];
  const input: string[] = [];
  const view = createSummonsView({
    screen: {
      print: (lines) => printed.push(...lines),
      status: (left, right) => status.push({ left, right }),
      setInput: (text) => input.push(text),
    },
    session,
    workspace: "datalake-loadtest",
    scope: "datalake-loadtest",
    callLogId: "20260820-1",
    ...options,
  });
  return { view, sent: state, printed, status, input, all: () => printed.join("\n") };
}

const toolEntry = (over: Partial<Extract<CallLogEntry, { type: "tool" }>> = {}): CallLogEntry => ({
  type: "tool",
  name: "tasks",
  target: "--frontier",
  outcome: "ok",
  durationMs: 1_200,
  number: 3,
  args: '{"ws":"servant-summon"}',
  result: '{"ready":1,"blocked":0}',
  ...over,
});

describe("the status line", () => {
  test("shows the level against the learned floor, which is the whole of servant-summon#3 you get for free", () => {
    expect(formatMicState({ muted: false, speaking: false, level: 1_400, floor: 900 })).toBe(
      "● listening   1.4k / floor 900",
    );
  });

  test("says the agent is speaking, and keeps the numbers — that is when they matter", () => {
    expect(formatMicState({ muted: false, speaking: true, level: 2_600, floor: 900 })).toBe(
      "▶ speaking   2.6k / floor 900",
    );
  });

  // A muted mic is heard by nobody however loud the room is, and a moving number would say the
  // opposite.
  test("a muted mic shows no numbers at all", () => {
    expect(formatMicState({ muted: true, speaking: false, level: 0, floor: 900 })).toBe("◼ muted");
  });

  test("an unlearned floor is a dash, not a zero — zero would read as a floor of nothing", () => {
    expect(formatMicState({ muted: false, speaking: false, level: 120, floor: null })).toContain(
      "floor —",
    );
  });

  test("the title names the workspace, and the repo only when it is not the whole workspace", () => {
    expect(formatSummonsTitle({ workspace: "ws", scope: "ws" })).toBe("servant summon · ws");
    expect(formatSummonsTitle({ workspace: "ws", scope: "repos/api" })).toBe(
      "servant summon · ws · repos/api",
    );
  });

  // A room where nothing can be talked over reads exactly like a broken one, so the flag is said.
  test("the title says when barge-in is off", () => {
    expect(formatSummonsTitle({ workspace: "ws", scope: "ws", bargeIn: false })).toContain(
      "barge-in off",
    );
  });

  // A mic that never started is exactly what the user is trying to read the status line about, so
  // the line cannot be waiting for a mic frame to exist.
  test("the Summons says what it is from the moment it opens", () => {
    const v = built();

    expect(v.status[0]).toEqual({
      left: "servant summon · datalake-loadtest",
      right: "● listening   0 / floor —",
    });
  });

  test("what the gate reports lands on the status line", () => {
    const v = built();

    v.view.micState({ muted: false, speaking: false, level: 800, floor: 600 } as SummonsMicState);

    expect(v.status.at(-1)).toEqual({
      left: "servant summon · datalake-loadtest",
      right: "● listening   800 / floor 600",
    });
  });
});

describe("typing to the Summons", () => {
  test("enter sends the line as a turn and empties the input", async () => {
    const v = built();

    await v.view.submit("actually check ticket 3");

    expect(v.sent.typed).toEqual(["actually check ticket 3"]);
    expect(v.input).toEqual([""]);
  });

  test("an empty line is not a turn", async () => {
    const v = built();

    await v.view.submit("   ");

    expect(v.sent.typed).toEqual([]);
    expect(v.input).toEqual([]);
  });

  // The transcript line comes from the Call log, not from the view putting it there itself — one
  // path, so what is on screen is what is on disk.
  test("the utterance reaches the screen through the record, not around it", async () => {
    const v = built();

    await v.view.submit("hello");
    expect(v.printed).toEqual([]);

    v.view.record({ type: "said", who: "user", text: "hello", channel: "typed" });
    expect(v.printed).toEqual(["you    ⌨ hello"]);
  });
});

describe("esc", () => {
  test("cuts the reply off and leaves the draft alone", () => {
    const v = built();

    v.view.escape();

    expect(v.sent.interrupts).toBe(1);
    expect(v.input).toEqual([]);
  });

  // The second meaning, and it only applies when the first one had nothing to do.
  test("with nothing playing, clears the input line", () => {
    const v = built();
    v.sent.cutOff = false;

    v.view.escape();

    expect(v.input).toEqual([""]);
  });
});

describe("history", () => {
  test("up walks back through what was typed, down walks out again", async () => {
    const v = built();
    await v.view.submit("first");
    await v.view.submit("second");
    v.input.length = 0;

    v.view.history("back", "");
    expect(v.input.at(-1)).toBe("second");
    v.view.history("back", "");
    expect(v.input.at(-1)).toBe("first");
    v.view.history("forward", "");
    expect(v.input.at(-1)).toBe("second");
  });

  test("a half-typed draft survives the trip through history", async () => {
    const v = built();
    await v.view.submit("earlier");
    v.input.length = 0;

    v.view.history("back", "half a sen");
    expect(v.input.at(-1)).toBe("earlier");

    v.view.history("forward", "earlier");
    expect(v.input.at(-1)).toBe("half a sen");
  });

  test("back past the oldest stays on the oldest, and empty history does nothing", () => {
    const empty = built();
    empty.view.history("back", "");
    expect(empty.input).toEqual([]);

    const v = built();
    void v.view.submit("only");
    v.input.length = 0;
    v.view.history("back", "");
    v.view.history("back", "");
    expect(v.input.at(-1)).toBe("only");
  });
});

describe("slash commands", () => {
  test("/tool prints the call in full, arguments and answer", () => {
    const v = built();
    v.view.record(toolEntry());
    v.printed.length = 0;

    void v.view.submit("/tool 3");

    expect(v.all()).toContain("tool 3 · tasks · --frontier · 1.2s");
    expect(v.all()).toContain('"ws": "servant-summon"');
    expect(v.all()).toContain('"ready": 1');
  });

  // The tools that answer their own call leave a richer entry a line below — a delegation, a steer,
  // a gate verdict. So the view says where the answer is instead of carrying a copy of it.
  test("/tool on a call that answered itself points at the entry that says what happened", () => {
    const v = built();
    v.view.record(toolEntry({ number: 4, name: "research", result: undefined }));
    v.printed.length = 0;

    void v.view.submit("/tool 4");

    expect(v.all()).toContain("tool 4 · research");
    expect(v.all()).toContain("answered itself");
  });

  test("/tool on a held delegation shows what it is waiting for, and no answer", () => {
    const v = built();
    v.view.record(
      toolEntry({
        number: 5,
        name: "delegate",
        outcome: "held",
        detail: "harden the gate",
        result: undefined,
      }),
    );
    v.printed.length = 0;

    void v.view.submit("/tool 5");

    expect(v.all()).toContain("held — waiting on a yes (harden the gate)");
    expect(v.all()).not.toContain("answered itself");
  });

  test("/tool on a number that has not happened yet says how many have", () => {
    const v = built();
    v.view.record(toolEntry({ number: 1 }));
    v.printed.length = 0;

    void v.view.submit("/tool 9");

    expect(v.all()).toContain("No tool call 9 yet — 1 so far");
  });

  test("/tool on a call that scrolled out of memory says where to read it", () => {
    const v = built();
    for (let n = 1; n <= TOOL_DETAIL_MEMORY + 5; n++) v.view.record(toolEntry({ number: n }));
    v.printed.length = 0;

    void v.view.submit("/tool 2");

    expect(v.all()).toContain("scrolled out of the view");
    expect(v.all()).toContain("servant call-log 20260820-1");
  });

  test("/tool without a number says so rather than guessing one", () => {
    const v = built();

    void v.view.submit("/tool");

    expect(v.all()).toContain("/tool wants a call number");
  });

  test("/mute is the mic key by another name", () => {
    const v = built();

    void v.view.submit("/mute");

    expect(v.sent.mutes).toBe(1);
    expect(v.sent.typed).toEqual([]);
  });

  test("/quit hangs up", () => {
    const v = built();

    void v.view.submit("/quit");

    expect(v.sent.stops).toBe(1);
  });

  test("/help lists every control, since none of them are guessable", () => {
    const v = built();

    void v.view.submit("/help");

    expect(v.all()).toContain("/tool N");
    expect(v.all()).toContain("esc");
    expect(SUMMONS_VIEW_HINT).toContain("/help");
  });

  // A typo said out loud to the agent is worse than a typo refused, and a refused line the user has
  // to retype is worse than one left where they can fix it.
  test("an unknown command is refused, not spoken, and the line is handed back", () => {
    const v = built();

    void v.view.submit("/tol 3");

    expect(v.sent.typed).toEqual([]);
    expect(v.all()).toContain("No such command: /tol");
    expect(v.input).toEqual(["", "/tol 3"]);
  });
});

describe("the transcript", () => {
  test("every kind of entry is printed the way the Plain view prints it", () => {
    const v = built();

    v.view.record({ type: "said", who: "servant", text: "one moment" });
    v.view.record(toolEntry());
    v.view.record({ type: "ended", reason: "hung up" });

    expect(v.printed).toEqual([
      "agent  ▸ one moment",
      "     3 · tasks        --frontier                            1.2s",
      "       — Summons ended (hung up)",
    ]);
  });

  test("secrets are scrubbed on the way to the screen, as they are on the way to disk", () => {
    const v = built();

    v.view.record({ type: "said", who: "servant", text: "the key is sk-abcdefghijklmnopqrstuvwx" });

    expect(v.all()).not.toContain("abcdefghijklmnop");
    expect(v.all()).toContain("[redacted]");
  });

  test("what the command itself has to say is printed too — the banner, --debug, a dead speaker", () => {
    const v = built();

    v.view.say("Call log: /tmp/one.jsonl");

    expect(v.printed).toEqual(["       · Call log: /tmp/one.jsonl"]);
  });
});
