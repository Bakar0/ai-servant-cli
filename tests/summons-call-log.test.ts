// What a Summons puts in its Call log, asserted at the controller seam — a fake Realtime transport
// in, a fake Call log port out. No socket, no disk, no terminal.

import { describe, expect, test } from "bun:test";
import { type CallLogEntry, RECORDED_TEXT_LIMIT } from "../src/core/call-log/record.ts";
import {
  type DelegationRequest,
  type RealtimeInbound,
  type RealtimeTransport,
  type SummonsActions,
  type SummonsSessionOptions,
  type TimerPort,
  type WorkspaceReader,
  createSummonsSession,
} from "../src/core/summons.ts";

function fakeTransport() {
  let emit: (event: RealtimeInbound) => Promise<void> = async () => {};
  const transport: RealtimeTransport = {
    async connect(_spec, onInbound) {
      emit = onInbound;
    },
    sendAudio() {},
    cancelResponse() {},
    truncateAudio() {},
    sendToolResult() {},
    sendAgentNote() {},
    promptAgent() {},
    sendUserText() {},
    async close() {},
  };
  return { transport, emit: (event: RealtimeInbound) => emit(event) };
}

function fakeReader(overrides: Partial<WorkspaceReader> = {}): WorkspaceReader {
  return {
    async readFile(path) {
      return `contents of ${path}`;
    },
    async glob() {
      return ["docs/adr/0009-talk.md"];
    },
    async grep() {
      return ["GOAL.md:3: ship the thing"];
    },
    ...overrides,
  };
}

function fakeActions(overrides: Partial<SummonsActions> = {}) {
  const launched: DelegationRequest[] = [];
  const actions: SummonsActions = {
    async delegate(request) {
      launched.push(request);
      return {
        label: request.label,
        sessionName: request.ticket ? `demo-t${request.ticket}` : `demo-${launched.length}`,
        ticket: request.ticket,
        repo: request.repo,
      };
    },
    async observe() {
      return { status: "running" as const, latest: "working on it", turns: 3 };
    },
    ...overrides,
  };
  return { actions, launched };
}

/** A clock that ticks a fixed amount per read, so recorded durations are exact. */
function tickingTimers(stepMs: number): TimerPort {
  let now = 0;
  return {
    now: () => {
      const at = now;
      now += stepMs;
      return at;
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
}

function summoned(opts: Partial<SummonsSessionOptions> = {}) {
  const { transport, emit } = fakeTransport();
  const recorded: CallLogEntry[] = [];
  const session = createSummonsSession({
    transport,
    reader: fakeReader(),
    instructions: "hi",
    idleTimeoutMs: 0,
    callLog: { record: (entry) => recorded.push(entry) },
    ...opts,
  });
  const of = <T extends CallLogEntry["type"]>(type: T) =>
    recorded.filter((e) => e.type === type) as Extract<CallLogEntry, { type: T }>[];
  return { session, emit, recorded, of };
}

const call = (name: string, args: Record<string, unknown>, callId = "call_1") =>
  ({ type: "tool_call", callId, name, args: JSON.stringify(args) }) as RealtimeInbound;

describe("a Summons records what was said", () => {
  test("both sides, in the order they were spoken", async () => {
    const { session, emit, of } = summoned();
    await session.start();

    await emit({ type: "user_transcript", text: "how's the ticket going" });
    await emit({ type: "assistant_transcript", text: "mid-implement" });

    expect(of("said")).toEqual([
      { type: "said", who: "user", text: "how's the ticket going" },
      { type: "said", who: "servant", text: "mid-implement" },
    ]);
  });

  test("a typed utterance is an utterance, and says which channel it arrived on", async () => {
    const { session, of } = summoned();
    await session.start();

    await session.typed("actually check ticket 3");

    expect(of("said")).toEqual([
      { type: "said", who: "user", text: "actually check ticket 3", channel: "typed" },
    ]);
  });

  test("nothing at all when the Summons was given no Call log", async () => {
    const { transport, emit } = fakeTransport();
    const session = createSummonsSession({
      transport,
      reader: fakeReader(),
      instructions: "hi",
      idleTimeoutMs: 0,
    });
    await session.start();
    await expect(emit({ type: "user_transcript", text: "hi" })).resolves.toBeUndefined();
  });
});

describe("a Summons records every tool it calls", () => {
  test("with the thing it touched, and how long it took", async () => {
    const { session, emit, of } = summoned({ timers: tickingTimers(10) });
    await session.start();

    await emit(call("read_file", { path: "GOAL.md" }));

    expect(of("tool")).toEqual([
      {
        type: "tool",
        name: "read_file",
        target: "GOAL.md",
        outcome: "ok",
        durationMs: 10,
        number: 1,
        args: '{"path":"GOAL.md"}',
        result: '{"content":"contents of GOAL.md"}',
      },
    ]);
  });

  // The line view shows `target` and nothing else, so without these there is nothing to open a
  // call up to — and a Summons whose answers are gone is a Summons you cannot check up on.
  test("with the arguments it was given and the answer that came back", async () => {
    const { session, emit, of } = summoned();
    await session.start();

    await emit(call("grep", { pattern: "createSummonsSession", glob: "src/**" }, "call_g"));

    expect(of("tool")[0]).toMatchObject({
      args: '{"pattern":"createSummonsSession","glob":"src/**"}',
      result: '{"matches":["GOAL.md:3: ship the thing"]}',
    });
  });

  // `/tool 7` is how a person asks to see one of these in full, so the number is the address and
  // has to be handed out in the order the calls were recorded.
  test("and a number of its own, counted per Summons", async () => {
    const { session, emit, of } = summoned();
    await session.start();

    await emit(call("read_file", { path: "GOAL.md" }));
    await emit(call("glob", { pattern: "docs/**" }, "call_2"));
    await emit(call("read_file", { path: "CONTEXT.md" }, "call_3"));

    expect(of("tool").map((t) => t.number)).toEqual([1, 2, 3]);
  });

  test("including the pattern a search ran, not just that a search ran", async () => {
    const { session, emit, of } = summoned();
    await session.start();

    await emit(call("glob", { pattern: "docs/**/*.md" }));
    await emit(call("grep", { pattern: "createSummonsSession" }, "call_2"));

    expect(of("tool").map((t) => t.target)).toEqual(["docs/**/*.md", "createSummonsSession"]);
  });

  test("and what went wrong when one fails", async () => {
    const { session, emit, of } = summoned({
      reader: fakeReader({
        async readFile() {
          throw new Error("no such file");
        },
      }),
    });
    await session.start();

    await emit(call("read_file", { path: "nope.md" }));

    expect(of("tool")[0]).toMatchObject({
      outcome: "error",
      detail: "no such file",
      args: '{"path":"nope.md"}',
      result: '{"error":"no such file"}',
    });
  });

  // Redacted at the call site, not left to the adapters: a long answer is cut down before it is
  // recorded, and a secret cut in half no longer looks like one to anything downstream.
  test("with anything key-shaped scrubbed out of the answer before it is recorded", async () => {
    const { session, emit, of } = summoned({
      reader: fakeReader({
        async readFile() {
          return "OPENAI_API_KEY=sk-proj-abc123DEF456ghi789JKL012mno345";
        },
      }),
    });
    await session.start();

    await emit(call("read_file", { path: ".env" }));

    expect(of("tool")[0]?.result).not.toContain("sk-proj-");
    expect(of("tool")[0]?.result).toContain("[redacted]");
  });

  // `read_file` on a large file answers with the whole of it. See `RECORDED_TEXT_LIMIT`.
  test("with a very long answer cut short, saying how much was dropped", async () => {
    const { session, emit, of } = summoned({
      reader: fakeReader({
        async readFile() {
          return "x".repeat(RECORDED_TEXT_LIMIT * 2);
        },
      }),
    });
    await session.start();

    await emit(call("read_file", { path: "big.md" }));

    const result = of("tool")[0]?.result ?? "";
    expect(result.length).toBeLessThan(RECORDED_TEXT_LIMIT + 100);
    expect(result).toContain("more characters");
  });

  test("even when the arguments were unreadable", async () => {
    const { session, emit, of } = summoned();
    await session.start();

    await emit({ type: "tool_call", callId: "call_x", name: "read_file", args: "{not json" });

    expect(of("tool")[0]).toMatchObject({ target: "(unreadable arguments)", outcome: "error" });
  });
});

describe("a Summons records the confirm-gate and what it released", () => {
  const propose = (emit: (e: RealtimeInbound) => Promise<void>, args: Record<string, unknown>) =>
    emit(call("delegate", args, "call_d"));

  test("a proposal is recorded as held — nothing has run", async () => {
    const { session, emit, of } = summoned({ actions: fakeActions().actions });
    await session.start();

    await propose(emit, { task: "refactor auth", label: "the auth refactor" });

    expect(of("tool")[0]).toMatchObject({ name: "delegate", outcome: "held" });
    // What was proposed is on the record; a result is not, because nothing ran to produce one.
    expect(of("tool")[0]?.args).toContain("refactor auth");
    expect(of("tool")[0]?.result).toBeUndefined();
    expect(of("delegation")).toEqual([]);
  });

  // Typed or spoken is the same turn, so the answer that releases a Guarded action can be either.
  // The mic is muted while you type, and a gate that only heard voices could not be answered at all.
  test("a typed yes releases it, exactly as a spoken one does", async () => {
    const { actions, launched } = fakeActions();
    const { session, emit, of } = summoned({ actions });
    await session.start();

    await propose(emit, { task: "refactor auth", label: "the auth refactor" });
    await session.typed("yes go ahead");

    expect(of("gate")).toEqual([
      { type: "gate", label: "the auth refactor", verdict: "confirmed", heard: "yes go ahead" },
    ]);
    expect(launched.map((r) => r.label)).toEqual(["the auth refactor"]);
  });

  test("and a typed no declines it, with nothing launched", async () => {
    const { actions, launched } = fakeActions();
    const { session, emit, of } = summoned({ actions });
    await session.start();

    await propose(emit, { task: "refactor auth", label: "the auth refactor" });
    await session.typed("no, leave it");

    expect(of("gate")[0]).toMatchObject({ verdict: "declined" });
    expect(launched).toEqual([]);
  });

  test("the verdict is recorded with the words it was read from", async () => {
    const { session, emit, of } = summoned({ actions: fakeActions().actions });
    await session.start();

    await propose(emit, { task: "refactor auth", label: "the auth refactor" });
    await emit({ type: "user_transcript", text: "yeah go ahead" });

    expect(of("gate")).toEqual([
      { type: "gate", label: "the auth refactor", verdict: "confirmed", heard: "yeah go ahead" },
    ]);
  });

  test("a declined delegation leaves a gate entry and no delegation", async () => {
    const { session, emit, of } = summoned({ actions: fakeActions().actions });
    await session.start();

    await propose(emit, { task: "refactor auth", label: "the auth refactor" });
    await emit({ type: "user_transcript", text: "no, don't" });

    expect(of("gate")[0]).toMatchObject({ verdict: "declined" });
    expect(of("delegation")).toEqual([]);
  });

  test("an unclear answer is recorded as unclear, so the record shows what was heard", async () => {
    const { session, emit, of } = summoned({ actions: fakeActions().actions });
    await session.start();

    await propose(emit, { task: "refactor auth", label: "the auth refactor" });
    await emit({ type: "user_transcript", text: "hmm hold on what was that" });

    expect(of("gate")[0]).toMatchObject({ verdict: "unclear" });
    expect(of("delegation")).toEqual([]);
  });
});

describe("a Summons records every Delegation, and which session carries it", () => {
  test("a confirmed delegation, with the session it was spawned into", async () => {
    const { session, emit, of } = summoned({ actions: fakeActions().actions });
    await session.start();

    await emit(
      call("delegate", { task: "refactor auth", label: "the auth refactor", ticket: 28 }, "call_d"),
    );
    await emit({ type: "user_transcript", text: "yes please" });

    expect(of("delegation")).toEqual([
      {
        type: "delegation",
        mode: "delegate",
        label: "the auth refactor",
        task: "refactor auth",
        session: "demo-t28",
        status: "launched",
        ticket: 28,
      },
    ]);
  });

  test("a read-only Delegation, which launches with no gate at all", async () => {
    const { session, emit, of } = summoned({ actions: fakeActions().actions });
    await session.start();

    await emit(
      call("research", { task: "how does the parser work", label: "the parser question" }),
    );

    expect(of("gate")).toEqual([]);
    expect(of("delegation")[0]).toMatchObject({
      mode: "research",
      status: "launched",
      session: "demo-1",
    });
    expect(of("tool")[0]).toMatchObject({
      name: "research",
      target: "the parser question",
      outcome: "ok",
    });
  });

  test("one queued behind another on the same repo, which is not running yet", async () => {
    const { session, emit, of } = summoned({ actions: fakeActions().actions });
    await session.start();

    await emit(call("research", { task: "a", label: "first", repo: "api" }, "call_1"));
    await emit(call("research", { task: "b", label: "second", repo: "api" }, "call_2"));

    expect(of("delegation")[1]).toMatchObject({
      label: "second",
      status: "queued",
      session: null,
      detail: "first",
    });
  });

  test("a nameless session is recorded as no session, not as a blank address", async () => {
    const { actions } = fakeActions({
      async delegate(request) {
        return { label: request.label, sessionName: "" };
      },
    });
    const { session, emit, of } = summoned({ actions });
    await session.start();

    await emit(call("research", { task: "a", label: "the nameless one" }));

    expect(of("delegation")[0]).toMatchObject({ status: "launched", session: null });
  });

  test("a launch that failed, so the record never implies work is running", async () => {
    const { actions } = fakeActions({
      async delegate() {
        throw new Error("no terminal available");
      },
    });
    const { session, emit, of } = summoned({ actions });
    await session.start();

    await emit(call("research", { task: "a", label: "the doomed one" }));

    expect(of("delegation")[0]).toMatchObject({
      status: "failed",
      session: null,
      detail: "no terminal available",
    });
  });
});

describe("a Summons records what its Hands session did", () => {
  const hands = (ask: (request: string) => Promise<string>) => ({ ask, end: async () => {} });
  const askHands = (emit: (e: RealtimeInbound) => Promise<void>, request: string) =>
    emit(call("ask_hands", { request }, "call_h"));

  test("the request is recorded as it goes out, not held back until the answer", async () => {
    let answer: ((text: string) => void) | null = null;
    const { session, emit, of } = summoned({
      hands: hands(() => new Promise<string>((resolve) => (answer = resolve))),
    });
    await session.start();

    const pending = askHands(emit, "run the whole suite");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The point of the entry: mid-request, the record already shows what is being waited on.
    expect(of("hands-asked")).toEqual([{ type: "hands-asked", request: "run the whole suite" }]);
    expect(of("hands")).toEqual([]);

    (answer as unknown as (text: string) => void)("all green");
    await pending;
    expect(of("hands")).toHaveLength(1);
  });

  test("what it was asked, what it came back with, and how long it took", async () => {
    const { session, emit, of } = summoned({
      timers: tickingTimers(500),
      hands: hands(async () => "3 tests failed, all in the parser"),
    });
    await session.start();

    await askHands(emit, "run the unit tests");

    expect(of("hands")).toEqual([
      {
        type: "hands",
        request: "run the unit tests",
        response: "3 tests failed, all in the parser",
        outcome: "ok",
        durationMs: 500,
      },
    ]);
  });

  test("a request that failed, which is the case nothing else would show", async () => {
    const { session, emit, of } = summoned({
      hands: hands(async () => {
        throw new Error("claude exited 1");
      }),
    });
    await session.start();

    await askHands(emit, "run the unit tests");

    expect(of("hands")[0]).toMatchObject({
      request: "run the unit tests",
      outcome: "error",
      response: "claude exited 1",
    });
  });

  test("as a Hands entry alone — it is not a Delegation, and carries no ticket to claim", async () => {
    const { actions, launched } = fakeActions();
    const { session, emit, of } = summoned({ actions, hands: hands(async () => "done") });
    await session.start();

    await askHands(emit, "run the unit tests");

    expect(launched).toEqual([]);
    expect(of("delegation")).toEqual([]);
    expect(of("tool")).toEqual([]);
    expect(of("hands")).toHaveLength(1);
  });

  test("a Summons killed mid-request still records what it was asked", async () => {
    const { session, emit, of } = summoned({
      hands: { ask: () => new Promise<string>(() => {}), end: async () => {} },
    });
    await session.start();

    void askHands(emit, "run the whole suite");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.stop();

    // The failure this closes: before the asking was its own moment, a Summons that died while its
    // Hands session was still working left no trace that it had ever been asked anything.
    expect(of("hands-asked")).toHaveLength(1);
    expect(of("ended")).toEqual([{ type: "ended", reason: "hung up" }]);
  });
});

describe("a Summons records the things a listener could not have inferred", () => {
  /** A silence in the record has to be explicable: a shut mic looks exactly like a quiet user. */
  test("the mic being muted, and unmuted again", async () => {
    const { session, of } = summoned();
    await session.start();

    session.toggleMute();
    session.toggleMute();

    const notes = of("note").map((n) => n.text);
    expect(notes[0]).toContain("muted");
    expect(notes[1]).toContain("unmuted");
  });

  // Without this the log holds a reply the user only heard the first second of, with nothing saying
  // why the rest never arrived.
  test("a reply the user talked over, so the log does not imply it was all heard", async () => {
    const { session, emit, of } = summoned({
      audio: {
        async startCapture() {},
        play() {},
        flush() {},
        endReply() {},
        async stop() {},
      },
    });
    await session.start();

    await emit({ type: "audio", pcm: Buffer.alloc(48_000).toString("base64"), itemId: "item_1" });
    await emit({ type: "user_speaking", itemId: "utterance_2" });

    expect(
      of("note")
        .map((n) => n.text)
        .join(" "),
    ).toContain("talked over");
  });

  // A reply cut off from the keyboard was not talked over, and a log that says it was reads as the
  // echo detector having fired — which is the thing `--no-barge-in` exists to rule out.
  test("a reply cut off from the keyboard says the keyboard did it", async () => {
    const { session, emit, of } = summoned({
      bargeIn: false,
      audio: {
        async startCapture() {},
        play() {},
        flush() {},
        endReply() {},
        async stop() {},
      },
    });
    await session.start();

    await emit({ type: "audio", pcm: Buffer.alloc(48_000).toString("base64"), itemId: "item_1" });
    session.interrupt();

    const notes = of("note")
      .map((n) => n.text)
      .join(" ");
    expect(notes).toContain("keyboard");
    expect(notes).not.toContain("talked over");
  });

  test("the ticket it filed, and where to find it", async () => {
    const { session, emit, of } = summoned({
      filing: {
        async file() {
          return { number: 42, url: "https://github.com/acme/hub/issues/42" };
        },
      },
    });
    await session.start();

    await emit(call("file_ticket", { title: "Pin the language", body: "Wrong script." }));
    await emit({ type: "user_transcript", text: "yes", itemId: "answer" });

    // The gate entry says what was heard to authorise it; this says what came of it.
    expect(of("gate")[0]).toMatchObject({ verdict: "confirmed" });
    expect(
      of("note")
        .map((n) => n.text)
        .join(" "),
    ).toContain("Filed #42");
  });
});

describe("a Summons records how it ended", () => {
  test("hanging up", async () => {
    const { session, of } = summoned();
    await session.start();
    await session.stop();

    expect(of("ended")).toEqual([{ type: "ended", reason: "hung up" }]);
  });

  test("the socket going away", async () => {
    const { session, emit, of } = summoned();
    await session.start();
    await emit({ type: "closed" });

    expect(of("ended")).toEqual([{ type: "ended", reason: "closed" }]);
  });

  test("hanging itself up on silence", async () => {
    let fire: (() => void) | null = null;
    const timers: TimerPort = {
      now: () => 0,
      setTimeout: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimeout: () => {},
    };
    const { session, of } = summoned({ timers, idleTimeoutMs: 180_000 });
    await session.start();
    (fire as unknown as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(of("ended")).toEqual([{ type: "ended", reason: "idle" }]);
  });

  test("an API error the user would otherwise only have heard as silence", async () => {
    const { session, emit, of } = summoned();
    await session.start();
    await emit({ type: "error", message: "rate limited" });

    expect(of("note")).toEqual([{ type: "note", level: "error", text: "rate limited" }]);
  });
});
