import { describe, expect, test } from "bun:test";
import {
  type AudioPort,
  PLAYBACK_TAIL_MS,
  type DelegationReport,
  type DelegationRequest,
  type HandsPort,
  type RealtimeInbound,
  type RealtimeSessionSpec,
  type RealtimeTransport,
  type SessionsPort,
  type SummonsActions,
  type SummonsSessionOptions,
  type TicketFilingPort,
  type TicketsPort,
  type TimerPort,
  type WorkspaceReader,
  createSummonsSession,
} from "../src/core/summons.ts";
import { requireAudioTool, requireOpenAiApiKey } from "../src/core/summons-preflight.ts";

/** A fake Realtime transport: records what the controller sent, replays scripted inbound events. */
function fakeTransport() {
  let emit: (event: RealtimeInbound) => Promise<void> = async () => {};
  const state = {
    spec: null as RealtimeSessionSpec | null,
    audioSent: [] as string[],
    toolResults: [] as { callId: string; output: string }[],
    notes: [] as string[],
    userTexts: [] as string[],
    cancelled: 0,
    truncated: [] as { itemId: string; playedMs: number }[],
    closed: false,
  };
  const transport: RealtimeTransport = {
    async connect(spec, onInbound) {
      state.spec = spec;
      emit = onInbound;
    },
    sendAudio(chunk) {
      state.audioSent.push(chunk);
    },
    cancelResponse() {
      state.cancelled += 1;
    },
    truncateAudio(itemId, playedMs) {
      state.truncated.push({ itemId, playedMs });
    },
    sendToolResult(callId, output) {
      state.toolResults.push({ callId, output });
    },
    sendAgentNote(text) {
      state.notes.push(text);
    },
    sendUserText(text) {
      state.userTexts.push(text);
    },
    async close() {
      state.closed = true;
    },
  };
  return { transport, state, emit: (event: RealtimeInbound) => emit(event) };
}

/** A fake workspace reader recording what the agent asked for. */
function fakeReader(overrides: Partial<WorkspaceReader> = {}) {
  const asked = { paths: [] as string[], globs: [] as string[], greps: [] as string[] };
  const reader: WorkspaceReader = {
    async readFile(path) {
      asked.paths.push(path);
      return `contents of ${path}`;
    },
    async glob(pattern) {
      asked.globs.push(pattern);
      return ["docs/adr/0009-talk.md"];
    },
    async grep(pattern) {
      asked.greps.push(pattern);
      return ["GOAL.md:3: ship the thing"];
    },
    ...overrides,
  };
  return { reader, asked };
}

const outputFor = (results: { callId: string; output: string }[], callId: string) =>
  JSON.parse(results.find((r) => r.callId === callId)?.output ?? "null");

/** A hand-driven clock, so playback and echo timing are asserted without waiting in real time. */
function fakeClock(start = 1_000) {
  let t = start;
  const timers: TimerPort = {
    now: () => t,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  return { timers, advance: (ms: number) => (t += ms) };
}

/**
 * A mic frame as the audio port delivers them: base64 PCM16 at 24 kHz, `ms` long, at a given
 * amplitude. Alternating sign so it has the RMS of real audio rather than of a DC offset — the
 * echo gate reads the level of these frames, so their loudness is part of the fixture.
 */
function micChunk(ms: number, amplitude = 0): string {
  const samples = Math.round((24_000 * ms) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    buffer.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return buffer.toString("base64");
}

/** A session with a mic and speaker, on a clock the test drives. */
async function audioSession(overrides: Partial<SummonsSessionOptions> = {}) {
  const { transport, state: sent, emit } = fakeTransport();
  const { timers, advance } = fakeClock();
  const flushes: number[] = [];
  let pushMic: (chunk: string) => void = () => {};
  const audio: AudioPort = {
    async startCapture(onChunk) {
      pushMic = onChunk;
    },
    play() {},
    flush() {
      flushes.push(timers.now());
    },
    endReply() {},
    async stop() {},
  };
  const session = createSummonsSession({
    transport,
    reader: fakeReader().reader,
    audio,
    instructions: "hi",
    idleTimeoutMs: 0,
    timers,
    ...overrides,
  });
  await session.start();
  return { session, sent, emit, advance, flushes, mic: (chunk: string) => pushMic(chunk) };
}

describe("summons startup", () => {
  test("connects with the assembled instructions and the configured voice and model", async () => {
    const { transport, state } = fakeTransport();
    const session = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      instructions: "You are the voice of workspace demo.",
      model: "gpt-realtime-custom",
      voice: "cedar",
    });

    await session.start();

    expect(state.spec?.instructions).toBe("You are the voice of workspace demo.");
    expect(state.spec?.model).toBe("gpt-realtime-custom");
    expect(state.spec?.voice).toBe("cedar");
  });

  test("falls back to the marin voice on gpt-realtime", async () => {
    const { transport, state } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      instructions: "hi",
    }).start();

    expect(state.spec?.model).toBe("gpt-realtime");
    expect(state.spec?.voice).toBe("marin");
  });

  test("offers only read-only tools — no edit, write or run-command tool", async () => {
    const { transport, state } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      instructions: "hi",
    }).start();

    const names = (state.spec?.tools ?? []).map((t) => t.name).toSorted();
    expect(names).toEqual(["glob", "grep", "read_file"]);
  });

  // The whole surface, with everything wired. Filing a ticket in the hub is the only thing here
  // that writes anywhere, and nothing here touches the working tree (workspace ADR 0009).
  test("with every port wired, the only tool that writes anything is the one that files a ticket", async () => {
    const { transport, state } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions: {
        async delegate(request) {
          return { label: request.label, sessionName: "demo-t1" };
        },
        async observe() {
          return { status: "running" as const, latest: null, turns: 0 };
        },
      },
      hands: {
        async ask() {
          return "ok";
        },
        async end() {},
      },
      sessions: { list: async () => ({ known: true, sessions: [] }) },
      tickets: {
        async claim() {
          return { known: true, session: null };
        },
        async comment() {},
      },
      filing: {
        async file() {
          return { number: 1, url: "https://example.invalid/issues/1" };
        },
      },
      instructions: "hi",
    }).start();

    expect((state.spec?.tools ?? []).map((t) => t.name).toSorted()).toEqual([
      "ask_hands",
      "check_delegation",
      "delegate",
      "file_ticket",
      "glob",
      "grep",
      "list_sessions",
      "read_file",
      "research",
      "steer_session",
      "stop_session",
    ]);
  });
});

describe("summons tool calls", () => {
  async function started(readerOverrides: Partial<WorkspaceReader> = {}) {
    const { transport, state, emit } = fakeTransport();
    const { reader, asked } = fakeReader(readerOverrides);
    const session = createSummonsSession({ transport, reader, instructions: "hi" });
    await session.start();
    return { state, emit, asked, session };
  }

  test("a read_file call is answered locally with the file's contents", async () => {
    const { state, emit, asked } = await started();

    await emit({
      type: "tool_call",
      callId: "call_1",
      name: "read_file",
      args: JSON.stringify({ path: "GOAL.md" }),
    });

    expect(asked.paths).toEqual(["GOAL.md"]);
    expect(outputFor(state.toolResults, "call_1")).toEqual({ content: "contents of GOAL.md" });
  });

  test("a glob call returns the matching paths", async () => {
    const { state, emit, asked } = await started();

    await emit({
      type: "tool_call",
      callId: "call_2",
      name: "glob",
      args: JSON.stringify({ pattern: "docs/**/*.md" }),
    });

    expect(asked.globs).toEqual(["docs/**/*.md"]);
    expect(outputFor(state.toolResults, "call_2")).toEqual({
      matches: ["docs/adr/0009-talk.md"],
    });
  });

  test("a grep call returns the matching lines", async () => {
    const { state, emit, asked } = await started();

    await emit({
      type: "tool_call",
      callId: "call_3",
      name: "grep",
      args: JSON.stringify({ pattern: "ship" }),
    });

    expect(asked.greps).toEqual(["ship"]);
    expect(outputFor(state.toolResults, "call_3")).toEqual({
      matches: ["GOAL.md:3: ship the thing"],
    });
  });

  test("a failed read is reported back to the agent instead of killing the session", async () => {
    const { state, emit } = await started({
      readFile: async () => {
        throw new Error("no such file");
      },
    });

    await emit({
      type: "tool_call",
      callId: "call_4",
      name: "read_file",
      args: JSON.stringify({ path: "nope.md" }),
    });

    expect(outputFor(state.toolResults, "call_4")).toEqual({ error: "no such file" });
  });

  test("an unknown tool is refused rather than executed", async () => {
    const { state, emit } = await started();

    await emit({
      type: "tool_call",
      callId: "call_5",
      name: "write_file",
      args: JSON.stringify({ path: "GOAL.md", content: "oops" }),
    });

    expect(outputFor(state.toolResults, "call_5")).toEqual({ error: "Unknown tool: write_file" });
  });

  test("malformed tool arguments are refused rather than executed", async () => {
    const { state, emit, asked } = await started();

    await emit({ type: "tool_call", callId: "call_6", name: "read_file", args: "{not json" });

    expect(asked.paths).toEqual([]);
    expect(outputFor(state.toolResults, "call_6").error).toContain("read_file");
  });
});

/**
 * Fake workspace actions: records every delegation instead of opening a tab, and reports whatever
 * the test says each session is doing. Nothing here spawns, claims or reads a transcript.
 */
function fakeActions(overrides: Partial<SummonsActions> = {}) {
  const launched: DelegationRequest[] = [];
  const reports = new Map<string, DelegationReport>();
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
    async observe(handle) {
      return (
        reports.get(handle.label) ?? {
          status: "running" as const,
          latest: "working on it",
          turns: 3,
        }
      );
    },
    ...overrides,
  };
  return { actions, launched, reports };
}

describe("delegating by voice is Guarded", () => {
  async function summoned(actionOverrides: Partial<SummonsActions> = {}) {
    const { transport, state, emit } = fakeTransport();
    const { actions, launched, reports } = fakeActions(actionOverrides);
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions,
      instructions: "hi",
    }).start();
    return { state, emit, launched, reports };
  }

  const propose = (
    emit: (e: RealtimeInbound) => Promise<void>,
    args: Record<string, unknown>,
    callId = "call_d",
  ) => emit({ type: "tool_call", callId, name: "delegate", args: JSON.stringify(args) });

  test("the delegation tools are offered once there is somewhere to delegate to", async () => {
    const { state } = await summoned();

    expect((state.spec?.tools ?? []).map((t) => t.name).toSorted()).toEqual([
      "check_delegation",
      "delegate",
      "glob",
      "grep",
      "read_file",
      "research",
    ]);
  });

  test("asking for heavy work launches nothing and comes back asking to confirm", async () => {
    const { state, emit, launched } = await summoned();

    await propose(emit, { task: "refactor the auth module", label: "auth refactor" });

    expect(launched).toEqual([]);
    const answer = outputFor(state.toolResults, "call_d");
    expect(answer.launched).toBe(false);
    expect(answer.status).toBe("awaiting_confirmation");
    expect(answer.instruction).toContain("yes or no");
  });

  test("a spoken yes launches it, with the task the agent wrote down", async () => {
    const { emit, launched } = await summoned();
    await propose(emit, { task: "refactor the auth module", label: "auth refactor", ticket: 42 });

    await emit({ type: "user_transcript", text: "Yes, go ahead.", itemId: "item_2" });

    expect(launched).toHaveLength(1);
    expect(launched[0]?.task).toBe("refactor the auth module");
    expect(launched[0]?.ticket).toBe(42);
  });

  test("a spoken no launches nothing", async () => {
    const { state, emit, launched } = await summoned();
    await propose(emit, { task: "delete the old migrations", label: "migrations" });

    await emit({ type: "user_transcript", text: "No.", itemId: "item_2" });

    expect(launched).toEqual([]);
    expect(state.notes.join(" ")).toContain("declined");
  });

  test("an unclear answer declines it, and the agent is told to ask again", async () => {
    const { state, emit, launched } = await summoned();
    await propose(emit, { task: "drop the staging database", label: "staging" });

    await emit({ type: "user_transcript", text: "sorry, what was that?", itemId: "item_2" });

    expect(launched).toEqual([]);
    expect(state.notes.join(" ")).toContain("Ask again");
  });

  test("a sentence that merely contains a yes is not a confirmation", async () => {
    const { emit, launched } = await summoned();
    await propose(emit, { task: "rewrite the build", label: "build" });

    await emit({
      type: "user_transcript",
      text: "I said yes to the other thing",
      itemId: "item_2",
    });

    expect(launched).toEqual([]);
  });

  test("the model cannot push a held delegation through by calling delegate again", async () => {
    const { state, emit, launched } = await summoned();
    await propose(emit, { task: "refactor auth", label: "auth" }, "call_a");

    await propose(emit, { task: "refactor auth", label: "auth", ticket: 1 }, "call_b");

    expect(launched).toEqual([]);
    expect(outputFor(state.toolResults, "call_b").error).toContain("waiting on a yes or no");
  });

  test("the request's own words, transcribed late, are not read as the answer to it", async () => {
    const { emit, launched } = await summoned();
    // The utterance that provoked the proposal, still being transcribed when the call arrived.
    await emit({ type: "user_speaking", itemId: "item_1" });
    await propose(emit, { task: "go and research the API", label: "api research" });

    await emit({ type: "user_transcript", text: "go and research the API", itemId: "item_1" });

    expect(launched).toEqual([]);

    // The gate is still held, so the real answer still works.
    await emit({ type: "user_transcript", text: "yes", itemId: "item_2" });
    expect(launched).toHaveLength(1);
  });

  test("a launch that fails leaves nothing running and says so", async () => {
    const { state, emit } = await summoned({
      async delegate() {
        throw new Error("no terminal available");
      },
    });
    await propose(emit, { task: "run the test suite", label: "tests" });

    await emit({ type: "user_transcript", text: "yes", itemId: "item_2" });

    expect(state.notes.join(" ")).toContain("no terminal available");
    expect(state.notes.join(" ")).toContain("Nothing is running");
  });

  test("a research request launches straight away — the gate is on change, not on effort", async () => {
    const { state, emit, launched } = await summoned();

    await emit({
      type: "tool_call",
      callId: "call_r",
      name: "research",
      args: JSON.stringify({ task: "how does the parser work", label: "parser question" }),
    });

    // No confirmation was asked for and none was given.
    expect(launched).toHaveLength(1);
    expect(launched[0]?.readOnly).toBe(true);
    expect(outputFor(state.toolResults, "call_r").launched).toBe(true);
  });

  test("a research request that arrives while a delegation is held does not disturb the gate", async () => {
    const { emit, launched } = await summoned();
    await propose(emit, { task: "refactor the auth module", label: "auth refactor" });

    await emit({
      type: "tool_call",
      callId: "call_r",
      name: "research",
      args: JSON.stringify({ task: "what calls the tokenizer", label: "tokenizer question" }),
    });

    // The research ran; the refactor is still waiting on a spoken yes.
    expect(launched.map((r) => r.label)).toEqual(["tokenizer question"]);

    await emit({ type: "user_transcript", text: "yes", itemId: "item_2" });
    expect(launched.map((r) => r.label)).toEqual(["tokenizer question", "auth refactor"]);
  });

  test("work sent through delegate is never marked read-only, whatever it is called", async () => {
    const { emit, launched } = await summoned();
    await propose(emit, { task: "just have a look at the parser", label: "parser" });

    await emit({ type: "user_transcript", text: "yes", itemId: "item_2" });

    expect(launched[0]?.readOnly).toBe(false);
  });

  test("a delegation with no task is refused rather than held", async () => {
    const { state, emit } = await summoned();

    await propose(emit, { label: "vague" });

    expect(outputFor(state.toolResults, "call_d").error).toContain("task");
  });
});

describe("watching delegated work", () => {
  async function summoned(actionOverrides: Partial<SummonsActions> = {}) {
    const { transport, state, emit } = fakeTransport();
    const { actions, launched, reports } = fakeActions(actionOverrides);
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions,
      instructions: "hi",
    }).start();

    let call = 0;
    async function delegated(args: Record<string, unknown>) {
      call += 1;
      await emit({
        type: "tool_call",
        callId: `d_${call}`,
        name: "delegate",
        args: JSON.stringify(args),
      });
      await emit({ type: "user_transcript", text: "yes", itemId: `confirm_${call}` });
    }
    async function check(args: Record<string, unknown> = {}) {
      call += 1;
      const callId = `c_${call}`;
      await emit({
        type: "tool_call",
        callId,
        name: "check_delegation",
        args: JSON.stringify(args),
      });
      return outputFor(state.toolResults, callId);
    }
    return { state, emit, launched, reports, delegated, check };
  }

  test("asking before anything has been delegated says so", async () => {
    const { check } = await summoned();

    expect((await check()).error).toContain("Nothing has been delegated");
  });

  test("asking how it is going reports progress from the running session", async () => {
    const { delegated, check, reports } = await summoned();
    await delegated({ task: "port the parser", label: "parser port" });
    reports.set("parser port", { status: "running", latest: "rewriting the tokenizer", turns: 4 });

    const result = await check();

    expect(result.status).toBe("running");
    expect(result.latest).toBe("rewriting the tokenizer");
    // Observing is silent: no confirmation was asked for and none was given.
    expect(result.needs_disambiguation).toBeUndefined();
  });

  test("asking what it concluded reports the outcome once it has finished", async () => {
    const { delegated, check, reports } = await summoned();
    await delegated({ task: "port the parser", label: "parser port" });
    reports.set("parser port", {
      status: "finished",
      latest: "the parser is ported; two tests still fail",
      turns: 20,
    });

    const result = await check({ label: "the parser port" });

    expect(result.status).toBe("finished");
    expect(result.latest).toContain("two tests still fail");
  });

  test("with several running, an unqualified check asks which one rather than picking", async () => {
    const { delegated, check } = await summoned();
    await delegated({ task: "port the parser", label: "parser port" });
    await delegated({ task: "research the API", label: "api research" });

    const result = await check();

    expect(result.needs_disambiguation).toBe(true);
    expect(result.delegations).toEqual(["parser port", "api research"]);
    expect(result.status).toBeUndefined();
  });

  test("naming one of several resolves to it", async () => {
    const { delegated, check, reports } = await summoned();
    await delegated({ task: "port the parser", label: "parser port" });
    await delegated({ task: "research the API", label: "api research" });
    reports.set("api research", { status: "running", latest: "reading the docs", turns: 2 });

    expect((await check({ label: "api research" })).latest).toBe("reading the docs");
  });

  test("a label nothing matches lists what there is instead of guessing", async () => {
    const { delegated, check } = await summoned();
    await delegated({ task: "port the parser", label: "parser port" });

    const result = await check({ label: "the database migration" });

    expect(result.error).toContain("database migration");
    expect(result.delegations).toEqual(["parser port"]);
  });
});

describe("dispatching delegated work", () => {
  async function summoned() {
    const { transport, state, emit } = fakeTransport();
    const { actions, launched, reports } = fakeActions();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions,
      instructions: "hi",
    }).start();

    let call = 0;
    async function delegated(args: Record<string, unknown>) {
      call += 1;
      await emit({
        type: "tool_call",
        callId: `d_${call}`,
        name: "delegate",
        args: JSON.stringify(args),
      });
      await emit({ type: "user_transcript", text: "yes", itemId: `confirm_${call}` });
    }
    async function check(args: Record<string, unknown> = {}) {
      call += 1;
      const callId = `c_${call}`;
      await emit({
        type: "tool_call",
        callId,
        name: "check_delegation",
        args: JSON.stringify(args),
      });
      return outputFor(state.toolResults, callId);
    }
    return { state, launched, reports, delegated, check };
  }

  test("work on different repos runs in parallel", async () => {
    const { delegated, launched } = await summoned();

    await delegated({ task: "fix the api", label: "api fix", repo: "backend" });
    await delegated({ task: "fix the ui", label: "ui fix", repo: "frontend" });

    expect(launched.map((r) => r.label)).toEqual(["api fix", "ui fix"]);
  });

  test("work on the same repo waits — two sessions would share one worktree", async () => {
    const { delegated, launched, state } = await summoned();

    await delegated({ task: "fix the api", label: "api fix", repo: "backend" });
    await delegated({ task: "add the endpoint", label: "new endpoint", repo: "backend" });

    expect(launched.map((r) => r.label)).toEqual(["api fix"]);
    expect(state.notes.join(" ")).toContain('queued behind "api fix"');
  });

  test("the queued task starts once the first is seen to have finished", async () => {
    const { delegated, check, launched, reports } = await summoned();
    await delegated({ task: "fix the api", label: "api fix", repo: "backend" });
    await delegated({ task: "add the endpoint", label: "new endpoint", repo: "backend" });

    reports.set("api fix", { status: "finished", latest: "done", turns: 9 });
    const result = await check({ label: "api fix" });

    expect(result.also_started).toBe("new endpoint");
    expect(launched.map((r) => r.label)).toEqual(["api fix", "new endpoint"]);
  });

  test("a queued task reports as queued, not as running", async () => {
    const { delegated, check } = await summoned();
    await delegated({ task: "fix the api", label: "api fix", repo: "backend" });
    await delegated({ task: "add the endpoint", label: "new endpoint", repo: "backend" });

    const result = await check({ label: "new endpoint" });

    expect(result.status).toBe("queued");
    expect(result.queued_behind).toBe("api fix");
  });

  test("asking about the queued task is itself enough to start it once the repo is free", async () => {
    const { delegated, check, launched, reports } = await summoned();
    await delegated({ task: "fix the api", label: "api fix", repo: "backend" });
    await delegated({ task: "add the endpoint", label: "new endpoint", repo: "backend" });
    reports.set("api fix", { status: "finished", latest: "done", turns: 9 });

    // Nobody asked about "api fix" — without this, the queued task would wait on someone
    // happening to enquire about the delegation ahead of it.
    const result = await check({ label: "new endpoint" });

    expect(launched.map((r) => r.label)).toEqual(["api fix", "new endpoint"]);
    expect(result.status).not.toBe("queued");
  });

  test("a repo whose occupant's liveness is unknown stays occupied", async () => {
    const { delegated, check, launched, reports } = await summoned();
    await delegated({ task: "fix the api", label: "api fix", repo: "backend" });
    await delegated({ task: "add the endpoint", label: "new endpoint", repo: "backend" });

    // "unknown" is not "finished": freeing the worktree on it would be the double-dispatch bug.
    reports.set("api fix", { status: "unknown", latest: null, turns: 0 });
    const result = await check({ label: "new endpoint" });

    expect(launched.map((r) => r.label)).toEqual(["api fix"]);
    expect(result.status).toBe("queued");
  });

  test("a repeated label is made unique, so a later check still resolves to one session", async () => {
    const { delegated, check, launched } = await summoned();

    await delegated({ task: "research the API", label: "api research" });
    await delegated({ task: "research the API again", label: "api research" });

    expect(launched.map((r) => r.label)).toEqual(["api research", "api research 2"]);
    expect((await check({ label: "api research 2" })).label).toBe("api research 2");
  });
});

describe("what a delegated session is told", () => {
  test("it carries the conversation the request came out of", async () => {
    const { transport, emit } = fakeTransport();
    const { actions, launched } = fakeActions();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions,
      instructions: "hi",
    }).start();

    await emit({ type: "user_transcript", text: "the parser keeps choking on unicode" });
    await emit({ type: "assistant_transcript", text: "want me to put Claude on it?" });
    await emit({
      type: "tool_call",
      callId: "d1",
      name: "delegate",
      args: JSON.stringify({ task: "fix unicode handling in the parser", label: "parser" }),
    });
    await emit({ type: "user_transcript", text: "yes", itemId: "confirm" });

    expect(launched[0]?.conversation).toContain("user: the parser keeps choking on unicode");
    expect(launched[0]?.conversation).toContain("servant: want me to put Claude on it?");
  });
});

describe("the Summons agent's own hands", () => {
  /** A fake Hands session: records what it was asked, never spawns anything. */
  function fakeHands(overrides: Partial<HandsPort> = {}) {
    const asked: string[] = [];
    const state = { ended: 0 };
    const hands: HandsPort = {
      async ask(request) {
        asked.push(request);
        return `did it: ${request}`;
      },
      async end() {
        state.ended += 1;
      },
      ...overrides,
    };
    return { hands, asked, state };
  }

  async function summoned(handsOverrides: Partial<HandsPort> = {}) {
    const { transport, state, emit } = fakeTransport();
    const { actions, launched } = fakeActions();
    const { hands, asked, state: handsState } = fakeHands(handsOverrides);
    const session = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions,
      hands,
      instructions: "hi",
    });
    await session.start();
    return { state, emit, session, asked, handsState, launched };
  }

  const ask = (emit: (e: RealtimeInbound) => Promise<void>, request: string, callId = "h1") =>
    emit({ type: "tool_call", callId, name: "ask_hands", args: JSON.stringify({ request }) });

  test("the hands tool is offered only when there is a Hands session to reach", async () => {
    const { state } = await summoned();
    expect((state.spec?.tools ?? []).map((t) => t.name)).toContain("ask_hands");

    const { transport, state: bare } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      instructions: "hi",
    }).start();
    expect((bare.spec?.tools ?? []).map((t) => t.name)).not.toContain("ask_hands");
  });

  test("asking gets the answer straight back, in the same breath", async () => {
    const { state, emit, asked } = await summoned();

    await ask(emit, "run the unit tests and tell me what fails");

    expect(asked).toEqual(["run the unit tests and tell me what fails"]);
    expect(outputFor(state.toolResults, "h1")).toEqual({
      answer: "did it: run the unit tests and tell me what fails",
    });
  });

  test("a second request goes to the same hands, so it can be referred back to", async () => {
    const { emit, asked } = await summoned();

    await ask(emit, "what does git blame say about summons.ts");
    await ask(emit, "and the line above the one you just read", "h2");

    expect(asked).toEqual([
      "what does git blame say about summons.ts",
      "and the line above the one you just read",
    ]);
  });

  test("a conversation that never needs hands never touches them", async () => {
    const { emit, asked, handsState } = await summoned();

    await emit({ type: "user_transcript", text: "what's the goal of this workspace" });
    await emit({
      type: "tool_call",
      callId: "r1",
      name: "read_file",
      args: JSON.stringify({ path: "GOAL.md" }),
    });

    expect(asked).toEqual([]);
    expect(handsState.ended).toBe(0);
  });

  test("hanging up ends the Hands session — it belongs to the conversation, not the machine", async () => {
    const { session, emit, handsState } = await summoned();

    await ask(emit, "run the tests");
    await session.stop();

    expect(handsState.ended).toBe(1);
  });

  test("a Hands session that will not end does not keep the Summons open", async () => {
    const { session, state } = await summoned({
      async end() {
        throw new Error("already gone");
      },
    });

    await session.stop();

    expect(state.closed).toBe(true);
  });

  test("a failed request is answered as an error rather than left unanswered", async () => {
    const { state, emit } = await summoned({
      async ask() {
        throw new Error("claude exited 1");
      },
    });

    await ask(emit, "run the tests");

    expect(outputFor(state.toolResults, "h1")).toEqual({ error: "claude exited 1" });
  });
});

describe("seeing what else is running", () => {
  async function summoned(sessions: SessionsPort) {
    const { transport, state, emit } = fakeTransport();
    const session = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions: fakeActions().actions,
      sessions,
      instructions: "hi",
    });
    await session.start();
    return { state, emit };
  }

  const listing = (
    sessions: { name: string; kind: "worker" | "hands" | "other"; ticket: number | null }[],
  ): SessionsPort => ({
    list: async () => ({
      known: true,
      sessions: sessions.map((s, at) => ({ ...s, status: "idle", pid: 100 + at })),
    }),
  });

  const askWhatIsRunning = (emit: (e: RealtimeInbound) => Promise<void>) =>
    emit({ type: "tool_call", callId: "s1", name: "list_sessions", args: "{}" });

  test("the tool is offered only when the Summons can actually see them", async () => {
    const { state } = await summoned(listing([]));
    expect((state.spec?.tools ?? []).map((t) => t.name)).toContain("list_sessions");

    const { transport, state: blind } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      instructions: "hi",
    }).start();
    expect((blind.spec?.tools ?? []).map((t) => t.name)).not.toContain("list_sessions");
  });

  test("what is running comes back with what each session is carrying", async () => {
    const { state, emit } = await summoned(
      listing([
        { name: "demo-t24", kind: "worker", ticket: 24 },
        { name: "demo-hands", kind: "hands", ticket: null },
      ]),
    );

    await askWhatIsRunning(emit);

    const answer = outputFor(state.toolResults, "s1");
    expect(answer.count).toBe(2);
    expect(answer.sessions[0]).toMatchObject({ name: "demo-t24", kind: "worker", ticket: 24 });
  });

  test("an unreadable registry is reported as not knowing, never as nothing running", async () => {
    const { state, emit } = await summoned({ list: async () => ({ known: false }) });

    await askWhatIsRunning(emit);

    // The live failure this closes: the agent said "there are no active sessions" while fourteen
    // were running. Not knowing has to be sayable, or the agent invents the confident answer.
    const answer = outputFor(state.toolResults, "s1");
    expect(answer.known).toBe(false);
    expect(answer.count).toBeUndefined();
    expect(answer.instruction).toContain("do not say nothing is running");
  });
});

describe("summons audio", () => {
  function fakeAudio() {
    const state = { played: [] as string[], capturing: false, stopped: false };
    let push: (chunk: string) => void = () => {};
    const audio: AudioPort = {
      async startCapture(onChunk) {
        state.capturing = true;
        push = onChunk;
      },
      play(pcm) {
        state.played.push(pcm);
      },
      flush() {},
      endReply() {},
      async stop() {
        state.stopped = true;
        state.capturing = false;
      },
    };
    return { audio, state, speak: (chunk: string) => push(chunk) };
  }

  test("captured mic audio is streamed to the model without any key being pressed", async () => {
    const { transport, state: sent } = fakeTransport();
    const { audio, state: mic, speak } = fakeAudio();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      audio,
      instructions: "hi",
    }).start();

    expect(mic.capturing).toBe(true);
    speak("bWlj");

    expect(sent.audioSent).toEqual(["bWlj"]);
  });

  test("the model's audio is played back", async () => {
    const { transport, emit } = fakeTransport();
    const { audio, state: mic } = fakeAudio();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      audio,
      instructions: "hi",
    }).start();

    await emit({ type: "audio", pcm: "c3BlZWNo" });

    expect(mic.played).toEqual(["c3BlZWNo"]);
  });

  test("stopping the session closes the socket and releases the microphone", async () => {
    const { transport, state: sent } = fakeTransport();
    const { audio, state: mic } = fakeAudio();
    const session = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      audio,
      instructions: "hi",
    });
    await session.start();

    await session.stop();

    expect(sent.closed).toBe(true);
    expect(mic.stopped).toBe(true);
  });
});

describe("typing to a Summons", () => {
  test("a typed utterance reaches the model as an ordinary user turn", async () => {
    const s = await audioSession();

    s.session.typed("actually check ticket 3");

    expect(s.sent.userTexts).toEqual(["actually check ticket 3"]);
  });

  test("an empty line is not a turn", async () => {
    const s = await audioSession();

    s.session.typed("   ");

    expect(s.sent.userTexts).toEqual([]);
  });

  // The point of typing is a muted mic and a keyboard, so typing must work with the mic shut — and
  // must not open it again, since mute is the user's to change and nothing else's.
  test("typing leaves the mic exactly as the user set it", async () => {
    const s = await audioSession();

    s.session.typed("one");
    s.advance(200);
    s.mic(micChunk(200, 3_000));
    expect(s.sent.audioSent).toHaveLength(1);

    s.session.toggleMute();
    s.session.typed("two");
    s.advance(200);
    s.mic(micChunk(200, 3_000));

    expect(s.sent.audioSent).toHaveLength(1);
    expect(s.sent.userTexts).toEqual(["one", "two"]);
  });

  test("a Summons that has hung up cannot be typed to", async () => {
    const s = await audioSession();
    await s.session.stop();

    s.session.typed("hello?");

    expect(s.sent.userTexts).toEqual([]);
  });
});

describe("summons idle hang-up", () => {
  /** Let the controller's async teardown settle after the timer fires. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A fake timer the test fires by hand, so the idle window is asserted without waiting. */
  function fakeTimers() {
    const state = { armedFor: [] as number[] };
    let pending: (() => void) | null = null;
    const timers: TimerPort = {
      now: () => 0,
      setTimeout(fn, ms) {
        state.armedFor.push(ms);
        pending = fn;
        return state.armedFor.length;
      },
      clearTimeout() {
        pending = null;
      },
    };
    return { timers, state, fire: () => pending?.() };
  }

  function build(idleTimeoutMs: number) {
    const { transport, state: sent, emit } = fakeTransport();
    const { timers, state: armed, fire } = fakeTimers();
    const ended: string[] = [];
    const session = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      instructions: "hi",
      idleTimeoutMs,
      timers,
      onStopped: () => ended.push("stopped"),
    });
    return { session, sent, emit, armed, fire, ended };
  }

  test("hangs up after the configured silence window and says so", async () => {
    const { session, sent, armed, fire, ended } = build(180_000);
    await session.start();

    expect(armed.armedFor).toEqual([180_000]);
    fire();
    await settle();

    expect(sent.closed).toBe(true);
    expect(ended).toEqual(["stopped"]);
  });

  test("conversation re-arms the window instead of hanging up mid-chat", async () => {
    const { session, sent, emit, armed, fire } = build(180_000);
    await session.start();

    await emit({ type: "assistant_transcript", text: "GOAL.md says ship it" });
    expect(armed.armedFor).toEqual([180_000, 180_000]);

    fire();
    await settle();
    expect(sent.closed).toBe(true);
  });

  test("a silent open mic still hangs up — audio bytes are not conversation", async () => {
    const { transport, state: sent } = fakeTransport();
    const { timers, state: armed, fire } = fakeTimers();
    let pushMic: (chunk: string) => void = () => {};
    const audio: AudioPort = {
      async startCapture(onChunk) {
        pushMic = onChunk;
      },
      play() {},
      flush() {},
      endReply() {},
      async stop() {},
    };
    const session = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      audio,
      instructions: "hi",
      idleTimeoutMs: 180_000,
      timers,
    });
    await session.start();

    // Silence still streams PCM frames; they must not count as activity.
    pushMic("c2lsZW5jZQ==");
    pushMic("c2lsZW5jZQ==");
    expect(armed.armedFor).toEqual([180_000]);

    fire();
    await settle();
    expect(sent.closed).toBe(true);
  });

  test("typing re-arms the window — a Summons being typed at is not silent", async () => {
    const { session, armed } = build(180_000);
    await session.start();

    session.typed("still here");

    expect(armed.armedFor).toEqual([180_000, 180_000]);
  });

  test("an idle timeout of zero leaves the session open indefinitely", async () => {
    const { session, armed } = build(0);
    await session.start();

    expect(armed.armedFor).toEqual([]);
  });
});

describe("summons preflight", () => {
  test("a missing audio tool is reported with an install hint", () => {
    expect(() => requireAudioTool(() => null)).toThrow(/brew install sox/);
    expect(requireAudioTool(() => "/opt/homebrew/bin/sox")).toBe("/opt/homebrew/bin/sox");
  });
});

describe("summons failures the user can hear about", () => {
  test("an API error is surfaced rather than leaving a silent open mic", async () => {
    const { transport, emit } = fakeTransport();
    const errors: string[] = [];
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      instructions: "hi",
      onError: (message) => errors.push(message),
    }).start();

    await emit({ type: "error", message: "invalid model" });

    expect(errors).toEqual(["invalid model"]);
  });

  test("a dropped socket ends the session instead of hanging on an open mic", async () => {
    const { transport, state: sent, emit } = fakeTransport();
    const audioStopped: string[] = [];
    const ended: string[] = [];
    const session = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      audio: {
        async startCapture() {},
        play() {},
        flush() {},
        endReply() {},
        async stop() {
          audioStopped.push("stopped");
        },
      },
      instructions: "hi",
      onStopped: () => ended.push("stopped"),
    });
    await session.start();

    await emit({ type: "closed" });

    expect(sent.closed).toBe(true);
    expect(audioStopped).toEqual(["stopped"]);
    expect(ended).toEqual(["stopped"]);
  });
});

describe("resolving the API key", () => {
  test("the shell environment is used when it has the key", () => {
    expect(requireOpenAiApiKey({ OPENAI_API_KEY: " sk-shell " }, {})).toBe("sk-shell");
  });

  test("the servant root's .env fills the gap when the shell has nothing", () => {
    expect(requireOpenAiApiKey({}, { OPENAI_API_KEY: "sk-file" })).toBe("sk-file");
    expect(requireOpenAiApiKey({ OPENAI_API_KEY: "  " }, { OPENAI_API_KEY: "sk-file" })).toBe(
      "sk-file",
    );
  });

  test("an inline override still wins over the file", () => {
    expect(
      requireOpenAiApiKey({ OPENAI_API_KEY: "sk-inline" }, { OPENAI_API_KEY: "sk-file" }),
    ).toBe("sk-inline");
  });

  test("absent from both names the variable and the file, without leaking a value", () => {
    let message = "";
    try {
      requireOpenAiApiKey({}, {});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain(".env");
  });
});

describe("a session that dies while it is still starting", () => {
  const reader = () => fakeReader().reader;

  function recordingAudio(events: string[], onStart?: () => Promise<void>): AudioPort {
    return {
      async startCapture() {
        events.push("mic-on");
        await onStart?.();
      },
      play() {},
      flush() {},
      endReply() {},
      async stop() {
        events.push("mic-off");
      },
    };
  }

  test("a socket that dies before the mic opens never opens it", async () => {
    const events: string[] = [];
    const transport: RealtimeTransport = {
      async connect(_spec, onInbound) {
        await onInbound({ type: "closed" });
      },
      sendAudio() {},
      cancelResponse() {},
      truncateAudio() {},
      sendToolResult() {},
      sendAgentNote() {},
      sendUserText() {},
      async close() {
        events.push("socket-closed");
      },
    };

    await createSummonsSession({
      transport,
      reader: reader(),
      audio: recordingAudio(events),
      instructions: "hi",
    }).start();

    expect(events).not.toContain("mic-on");
    expect(events).toContain("socket-closed");
  });

  test("a socket that dies while the mic is opening still releases it", async () => {
    const events: string[] = [];
    let die: () => Promise<void> = async () => {};
    const transport: RealtimeTransport = {
      async connect(_spec, onInbound) {
        die = () => onInbound({ type: "closed" });
      },
      sendAudio() {},
      cancelResponse() {},
      truncateAudio() {},
      sendToolResult() {},
      sendAgentNote() {},
      sendUserText() {},
      async close() {
        events.push("socket-closed");
      },
    };

    await createSummonsSession({
      transport,
      reader: reader(),
      audio: recordingAudio(events, () => die()),
      instructions: "hi",
    }).start();

    // The mic opened, so it must be closed again — otherwise sox outlives the session.
    expect(events.at(0)).toBe("mic-on");
    expect(events).toContain("mic-off");
  });
});

describe("the agent does not hear itself", () => {
  /** One second of 24 kHz mono PCM16 = 48000 bytes, base64-encoded. */
  const ONE_SECOND_OF_SPEECH = Buffer.alloc(48_000).toString("base64");

  async function speakingSession() {
    const { transport, state: sent, emit } = fakeTransport();
    const { timers, advance } = fakeClock();
    let pushMic: (chunk: string) => void = () => {};
    const audio: AudioPort = {
      async startCapture(onChunk) {
        pushMic = onChunk;
      },
      play() {},
      flush() {},
      endReply() {},
      async stop() {},
    };
    const session = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      audio,
      instructions: "hi",
      idleTimeoutMs: 0,
      timers,
    });
    await session.start();
    return { sent, emit, advance, mic: (chunk: string) => pushMic(chunk) };
  }

  test("mic input is held back while the model's reply is still playing", async () => {
    const { sent, emit, advance, mic } = await speakingSession();

    mic("aGVhcmQ=");
    expect(sent.audioSent).toEqual(["aGVhcmQ="]);

    await emit({ type: "audio", pcm: ONE_SECOND_OF_SPEECH });
    advance(300); // 300ms into a one-second reply
    mic("ZWNobw==");

    expect(sent.audioSent).toEqual(["aGVhcmQ="]);
  });

  test("mic input resumes once the reply has finished playing", async () => {
    const { sent, emit, advance, mic } = await speakingSession();

    await emit({ type: "audio", pcm: ONE_SECOND_OF_SPEECH });
    advance(2_000); // well past the reply plus its tail
    mic("bXktdHVybg==");

    expect(sent.audioSent).toEqual(["bXktdHVybg=="]);
  });

  test("back-to-back audio deltas extend the quiet window rather than resetting it", async () => {
    const { sent, emit, advance, mic } = await speakingSession();

    await emit({ type: "audio", pcm: ONE_SECOND_OF_SPEECH });
    advance(500);
    await emit({ type: "audio", pcm: ONE_SECOND_OF_SPEECH });
    advance(1_000); // 1.5s in, but 2s of speech was queued

    mic("c3RpbGwtcGxheWluZw==");

    expect(sent.audioSent).toEqual([]);
  });

  test("the frame straddling the end of playback is held — all of it is echo", async () => {
    const { sent, emit, advance, mic } = await speakingSession();

    await emit({ type: "audio", pcm: ONE_SECOND_OF_SPEECH });
    // A frame is ~200ms of *history*, so a frame that arrives 100ms after the window closes began
    // 100ms before it did. Judging it on its arrival time admits a frame of the agent's own voice,
    // which is all the model's voice detection needs to make it interrupt itself.
    advance(1_000 + PLAYBACK_TAIL_MS + 100);
    mic(micChunk(200));
    expect(sent.audioSent).toEqual([]);

    // The next frame begins after the window and is the user's turn.
    advance(200);
    mic(micChunk(200));
    expect(sent.audioSent).toHaveLength(1);
  });
});

describe("barging in on the agent", () => {
  /** The agent's own voice returning through the speakers — what the gate has to ignore. */
  const ECHO = 900;
  /** Somebody in the room talking over it, well clear of the echo. */
  const SPEECH = 6_000;

  /** A session four seconds into a reply it is still playing out. */
  async function agentTalking(overrides: Partial<SummonsSessionOptions> = {}) {
    const session = await audioSession(overrides);
    await session.emit({ type: "audio", pcm: micChunk(4_000), itemId: "item_1" });
    return session;
  }

  /** Feed one 200ms frame, a frame's worth of clock later. */
  function frame(s: Awaited<ReturnType<typeof agentTalking>>, amplitude: number, count = 1): void {
    for (let i = 0; i < count; i++) {
      s.advance(200);
      s.mic(micChunk(200, amplitude));
    }
  }

  test("speaking over the agent cancels the reply, flushes playback and reopens the mic", async () => {
    const s = await agentTalking();

    // Two frames of the agent's own voice coming back in: this is the echo floor, not a person.
    frame(s, ECHO, 2);
    expect(s.sent.cancelled).toBe(0);
    expect(s.flushes).toEqual([]);

    // Now somebody starts talking over it.
    frame(s, SPEECH, 2);

    expect(s.sent.cancelled).toBe(1);
    expect(s.flushes).toHaveLength(1);
    // 800ms of a four-second reply actually reached the room, and that is what the model is told
    // it said — otherwise it refers back to sentences nobody heard.
    expect(s.sent.truncated).toEqual([{ itemId: "item_1", playedMs: 800 }]);

    // The mic is open again immediately: the rest of the sentence has to reach the model, and the
    // audio it was being held back for no longer exists.
    frame(s, SPEECH);
    expect(s.sent.audioSent).toHaveLength(1);
  });

  test("the agent's own echo never interrupts it, however long the reply runs", async () => {
    const s = await agentTalking();

    frame(s, ECHO, 15);

    expect(s.sent.cancelled).toBe(0);
    expect(s.flushes).toEqual([]);
    expect(s.sent.audioSent).toEqual([]);
  });

  // The live failure this closes. A frame is 200ms of history, so the first frame of the playback
  // window was recorded *before* any sound left the speakers — it is silence. Seeding the echo floor
  // from it put the floor at nearly zero, every real echo frame after it cleared the threshold, and
  // the agent flushed and respawned its own speaker every 400ms for the length of the reply. On the
  // speakers that is not speech, it is a growl; the log showed a perfectly ordinary reply.
  test("the silence just before playback starts does not become the echo floor", async () => {
    const s = await agentTalking();

    // A frame arriving 100ms into the reply covers the 200ms before it — mostly the room from
    // *before* the agent spoke, so it says nothing about how loud the echo is.
    s.advance(100);
    s.mic(micChunk(200, 0));

    // Room echo at an ordinary speaker volume, far above any absolute idea of "loud enough to be a
    // voice" — the only thing that can tell it from a person is a floor learned from real echo.
    frame(s, 4_000, 12);

    expect(s.sent.cancelled).toBe(0);
    expect(s.flushes).toEqual([]);
  });

  test("the speakers turned up do not interrupt the agent — the threshold is relative to the room", async () => {
    const s = await agentTalking();

    // Echo well above any absolute idea of "loud enough to be speech": only a floor learned from
    // this room at this volume can tell it apart from a person.
    frame(s, 4_000, 4);
    expect(s.sent.cancelled).toBe(0);

    frame(s, 12_000, 2);
    expect(s.sent.cancelled).toBe(1);
  });

  test("a loud frame with nothing playing is just the user talking, not a barge-in", async () => {
    const s = await audioSession();

    s.advance(200);
    s.mic(micChunk(200, SPEECH));
    s.advance(200);
    s.mic(micChunk(200, SPEECH));

    expect(s.sent.cancelled).toBe(0);
    expect(s.flushes).toEqual([]);
    expect(s.sent.audioSent).toHaveLength(2);
  });

  test("one loud frame is a door, not an interruption — it takes two to cut the agent off", async () => {
    const s = await agentTalking();
    frame(s, ECHO, 2);

    frame(s, SPEECH);

    expect(s.sent.cancelled).toBe(0);

    // And a single spike does not leave the detector primed: the count starts over.
    frame(s, ECHO, 2);
    frame(s, SPEECH);
    expect(s.sent.cancelled).toBe(0);
  });

  test("the server hearing the user mid-reply cuts it off, whatever the mic is doing", async () => {
    const s = await agentTalking();

    s.advance(300);
    await s.emit({ type: "user_speaking", itemId: "utterance_9" });

    expect(s.sent.cancelled).toBe(1);
    expect(s.flushes).toHaveLength(1);
    expect(s.sent.truncated).toEqual([{ itemId: "item_1", playedMs: 300 }]);
  });

  test("with headphones the mic is never gated, so the server does the hearing", async () => {
    const s = await agentTalking({ headphones: true });

    // No echo to protect against, so nothing is held back mid-reply — which is what lets the
    // server's voice detection notice the interruption in the first place.
    s.advance(300);
    s.mic(micChunk(200, SPEECH));
    expect(s.sent.audioSent).toHaveLength(1);

    await s.emit({ type: "user_speaking", itemId: "utterance_9" });
    expect(s.sent.cancelled).toBe(1);
    expect(s.flushes).toHaveLength(1);
  });

  test("a reply that has finished generating is flushed, not cancelled", async () => {
    const s = await agentTalking();

    // The model produces audio faster than it plays, so by the time the user talks over the tail of
    // a reply there is often nothing left to cancel. Asking anyway is an API error the user would
    // hear about for no reason — the queued audio still has to go.
    await s.emit({ type: "reply_done" });
    s.advance(300);
    await s.emit({ type: "user_speaking", itemId: "utterance_9" });

    expect(s.sent.cancelled).toBe(0);
    expect(s.flushes).toHaveLength(1);
    expect(s.sent.truncated).toEqual([{ itemId: "item_1", playedMs: 300 }]);
  });

  test("taking your turn after the agent finished is not an interruption", async () => {
    const s = await agentTalking();

    // The reply played all the way out and the user answered normally, seconds later. Reading that
    // as a barge-in would flush a speaker with nothing in it, truncate a message that was heard in
    // full, and put an interruption in the Call log on every single turn.
    await s.emit({ type: "reply_done" });
    s.advance(30_000);
    await s.emit({ type: "user_speaking", itemId: "utterance_9" });

    expect(s.sent.cancelled).toBe(0);
    expect(s.sent.truncated).toEqual([]);
    expect(s.flushes).toEqual([]);
  });

  test("the user starting a turn with nothing playing cancels nothing", async () => {
    const s = await audioSession();

    await s.emit({ type: "user_speaking", itemId: "utterance_1" });

    expect(s.sent.cancelled).toBe(0);
    expect(s.sent.truncated).toEqual([]);
    expect(s.flushes).toEqual([]);
  });

  test("with barge-in off nothing cuts a reply short, whichever half heard it", async () => {
    const s = await agentTalking({ bargeIn: false });

    // Loud enough, for long enough, that the detector would have cut in several times over...
    frame(s, SPEECH, 8);
    // ...and the server's own voice detection saying the same thing.
    await s.emit({ type: "user_speaking", itemId: "utterance_9" });

    expect(s.sent.cancelled).toBe(0);
    expect(s.sent.truncated).toEqual([]);
    expect(s.flushes).toEqual([]);
  });

  test("Esc cuts the reply off, exactly as a voice barge-in does", async () => {
    const s = await agentTalking();
    s.advance(300);

    s.session.interrupt();

    expect(s.sent.cancelled).toBe(1);
    expect(s.sent.truncated).toEqual([{ itemId: "item_1", playedMs: 300 }]);
    expect(s.flushes).toHaveLength(1);
  });

  // The sibling of the test above it. `--no-barge-in` suppresses *guesses* about whether a person
  // is talking, and a keypress is not a guess — so it is the one source the flag does not reach.
  test("the keyboard is obeyed with barge-in off, unlike either detector", async () => {
    const s = await agentTalking({ bargeIn: false });

    frame(s, SPEECH, 8);
    await s.emit({ type: "user_speaking", itemId: "utterance_9" });
    expect(s.sent.cancelled).toBe(0);

    s.session.interrupt();

    expect(s.sent.cancelled).toBe(1);
    expect(s.sent.truncated).toHaveLength(1);
    expect(s.flushes).toHaveLength(1);
  });

  test("Esc with nothing playing cuts nothing off", async () => {
    const s = await audioSession();

    s.session.interrupt();

    expect(s.sent.cancelled).toBe(0);
    expect(s.sent.truncated).toEqual([]);
    expect(s.flushes).toEqual([]);
  });

  test("a muted mic cannot barge in — that is the whole point of muting it", async () => {
    const s = await agentTalking();
    s.session.toggleMute();

    frame(s, SPEECH, 6);

    expect(s.sent.cancelled).toBe(0);
    expect(s.flushes).toEqual([]);
  });
});

describe("filing a hub ticket by voice is Guarded", () => {
  function fakeFiling(overrides: Partial<TicketFilingPort> = {}) {
    const filed: { title: string; body: string }[] = [];
    const filing: TicketFilingPort = {
      async file(request) {
        filed.push(request);
        return { number: 42, url: "https://github.com/acme/hub/issues/42" };
      },
      ...overrides,
    };
    return { filing, filed };
  }

  async function summoned(filing: TicketFilingPort) {
    const { transport, state, emit } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      filing,
      instructions: "hi",
    }).start();
    return { state, emit };
  }

  const propose = (
    emit: (e: RealtimeInbound) => Promise<void>,
    args: Record<string, unknown> = {
      title: "Pin the transcription language",
      body: "Utterances come back in the wrong script.",
    },
    callId = "f1",
  ) => emit({ type: "tool_call", callId, name: "file_ticket", args: JSON.stringify(args) });

  const said = (emit: (e: RealtimeInbound) => Promise<void>, text: string) =>
    emit({ type: "user_transcript", text, itemId: "answer" });

  test("asking for a ticket files nothing and sends the agent to ask out loud", async () => {
    const { filing, filed } = fakeFiling();
    const { state, emit } = await summoned(filing);

    await propose(emit);

    expect(filed).toEqual([]);
    const answer = outputFor(state.toolResults, "f1");
    expect(answer.status).toBe("awaiting_confirmation");
    expect(answer.filed).toBe(false);
    expect(answer.instruction).toMatch(/yes or no/i);
  });

  test("a spoken yes files it in the hub and the agent is given the number", async () => {
    const { filing, filed } = fakeFiling();
    const { state, emit } = await summoned(filing);

    await propose(emit);
    await said(emit, "yes");

    expect(filed).toEqual([
      {
        title: "Pin the transcription language",
        body: "Utterances come back in the wrong script.",
      },
    ]);
    expect(state.notes.join(" ")).toContain("#42");
  });

  test("a no files nothing", async () => {
    const { filing, filed } = fakeFiling();
    const { state, emit } = await summoned(filing);

    await propose(emit);
    await said(emit, "no, leave it");

    expect(filed).toEqual([]);
    expect(state.notes.join(" ")).toMatch(/did NOT go ahead|declined/);
  });

  test("an answer that is not a plain yes files nothing", async () => {
    const { filing, filed } = fakeFiling();
    const { state, emit } = await summoned(filing);

    await propose(emit);
    await said(emit, "well, maybe file it later, I suppose");

    expect(filed).toEqual([]);
    expect(state.notes.join(" ")).toContain("not a clear yes");
  });

  test("a late transcript of the request itself is not the answer to it", async () => {
    const { filing, filed } = fakeFiling();
    const { emit } = await summoned(filing);

    // Transcription lags: the utterance that *caused* the proposal can land after it.
    await emit({ type: "user_speaking", itemId: "the-request" });
    await propose(emit);
    await emit({
      type: "user_transcript",
      text: "yes, file that as a ticket",
      itemId: "the-request",
    });

    expect(filed).toEqual([]);
    // Still held, so the real answer still lands.
    await said(emit, "yes");
    expect(filed).toHaveLength(1);
  });

  test("only one question is in the air at a time", async () => {
    const { filing, filed } = fakeFiling();
    const { state, emit } = await summoned(filing);

    await propose(emit);
    await propose(emit, { title: "Something else", body: "..." }, "f2");

    expect(outputFor(state.toolResults, "f2").error).toMatch(/already waiting/);
    // And the yes that follows releases the first one, not the second.
    await said(emit, "yes");
    expect(filed).toEqual([
      {
        title: "Pin the transcription language",
        body: "Utterances come back in the wrong script.",
      },
    ]);
  });

  test("a hub that refuses the write is reported as nothing filed", async () => {
    const { filing } = fakeFiling({
      async file() {
        throw new Error("gh: could not create issue");
      },
    });
    const { state, emit } = await summoned(filing);

    await propose(emit);
    await said(emit, "yes");

    expect(state.notes.join(" ")).toContain("Nothing was filed");
  });

  test("the tool is not offered at all when there is no hub to file to", async () => {
    const { transport, state } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      instructions: "hi",
    }).start();

    expect((state.spec?.tools ?? []).map((t) => t.name)).not.toContain("file_ticket");
  });
});

describe("muting the mic", () => {
  test("a mute toggle suspends input, and unmuting resumes it", async () => {
    const { session, sent, mic } = await audioSession();

    expect(session.toggleMute()).toBe(true);
    mic(micChunk(200, 8_000));
    expect(sent.audioSent).toEqual([]);

    expect(session.toggleMute()).toBe(false);
    mic(micChunk(200, 8_000));
    expect(sent.audioSent).toHaveLength(1);
  });

  test("a muted mic stays shut through a reply — unmuting is the only thing that opens it", async () => {
    const { session, sent, emit, advance, mic } = await audioSession();
    session.toggleMute();

    await emit({ type: "audio", pcm: micChunk(1_000) });
    advance(2_000); // well past the reply and its tail, so only the mute is holding the mic
    mic(micChunk(200, 8_000));

    expect(sent.audioSent).toEqual([]);
  });
});

describe("steering a running session", () => {
  /** A fake Hands session standing in for the relay — no `claude`, no SendMessage, no socket. */
  function fakeHands(
    reply: (request: string) => string | Promise<string> = () => "SERVANT-STEER: delivered",
  ) {
    const asked: string[] = [];
    const hands: HandsPort = {
      async ask(request) {
        asked.push(request);
        return reply(request);
      },
      async end() {},
    };
    return { hands, asked };
  }

  /** A fake hub: records every ticket comment written, answers who holds each Claim. */
  function fakeTickets(claims: Record<number, string | null> = {}) {
    const comments: { ticket: number; body: string }[] = [];
    const tickets: TicketsPort = {
      async claim(ticket) {
        return { known: true, session: claims[ticket] ?? null };
      },
      async comment(ticket, body) {
        comments.push({ ticket, body });
      },
    };
    return { tickets, comments };
  }

  const listing = (
    sessions: { name: string; kind: "worker" | "hands" | "other"; ticket: number | null }[],
  ): SessionsPort => ({
    list: async () => ({
      known: true,
      sessions: sessions.map((s, at) => ({ ...s, status: "busy", pid: 100 + at })),
    }),
  });

  /** One Worker on #23 and the conversation's own hands — the ordinary case. */
  const oneWorker = () =>
    listing([
      { name: "demo-t23", kind: "worker", ticket: 23 },
      { name: "demo-hands", kind: "hands", ticket: null },
    ]);

  async function summoned(
    opts: {
      sessions?: SessionsPort;
      hands?: HandsPort;
      tickets?: TicketsPort;
    } = {},
  ) {
    const { transport, state, emit } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions: fakeActions().actions,
      sessions: opts.sessions ?? oneWorker(),
      hands: opts.hands ?? fakeHands().hands,
      tickets: opts.tickets ?? fakeTickets({ 23: "demo-t23" }).tickets,
      instructions: "hi",
    }).start();
    return { state, emit };
  }

  const steer = (
    emit: (e: RealtimeInbound) => Promise<void>,
    args: Record<string, unknown>,
    callId = "st1",
  ) => emit({ type: "tool_call", callId, name: "steer_session", args: JSON.stringify(args) });

  test("the steering tools are offered once there is a relay and a registry to resolve against", async () => {
    const { state } = await summoned();

    const names = (state.spec?.tools ?? []).map((t) => t.name);
    expect(names).toContain("steer_session");
    expect(names).toContain("stop_session");
  });

  test("without hands there is nothing to relay through, so neither tool is offered", async () => {
    const { transport, state } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      sessions: oneWorker(),
      instructions: "hi",
    }).start();

    const names = (state.spec?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("steer_session");
    expect(names).not.toContain("stop_session");
  });

  // AC 2. The Summons agent is not a Claude session and cannot address a Worker; what it does is
  // ask its hands to. The assertion is that the instruction went through the relay at all.
  test("the instruction goes out through the Hands session, never straight at the Worker", async () => {
    const { hands, asked } = fakeHands();
    const { emit } = await summoned({ hands });

    await steer(emit, {
      session: "demo-t23",
      instruction: "rebase onto main before you go further",
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("demo-t23");
    expect(asked[0]).toContain("rebase onto main before you go further");
  });

  // AC 8 travels with the message rather than being assumed of the receiver.
  test("what the session is handed tells it to wait for a safe point", async () => {
    const { hands, asked } = fakeHands();
    const { emit } = await summoned({ hands });

    await steer(emit, { session: "demo-t23", instruction: "also check the tests" });

    expect(asked[0]?.toLowerCase()).toContain("safe point");
  });

  // AC 3, the half that works.
  test("a confirmed send is reported as delivered — and pointedly not as done", async () => {
    const { state, emit } = await summoned();

    await steer(emit, { session: "demo-t23", instruction: "rebase first" });

    const answer = outputFor(state.toolResults, "st1");
    expect(answer.status).toBe("delivered");
    expect(answer.session).toBe("demo-t23");
    expect(answer.instruction).toContain("safe point");
    expect(answer.instruction.toLowerCase()).not.toContain("it is doing");
  });

  // AC 3, the half that matters. A relay that answered in prose has proven nothing, and the
  // difference between "queued" and "applied" is exactly what the agent must not paper over.
  test("a relay that did not confirm the send is unconfirmed, never delivered", async () => {
    const { hands } = fakeHands(() => "Sure, I passed that along.");
    const { state, emit } = await summoned({ hands });

    await steer(emit, { session: "demo-t23", instruction: "rebase first" });

    const answer = outputFor(state.toolResults, "st1");
    expect(answer.status).toBe("unconfirmed");
    expect(answer.instruction).toContain("do not say it was delivered");
  });

  test("a relay that reports a failure says so, with the reason", async () => {
    const { hands } = fakeHands(() => "SERVANT-STEER: failed — that session has no inbox");
    const { state, emit } = await summoned({ hands });

    await steer(emit, { session: "demo-t23", instruction: "rebase first" });

    const answer = outputFor(state.toolResults, "st1");
    expect(answer.status).toBe("failed");
    expect(answer.reason).toBe("that session has no inbox");
  });

  test("a relay that threw is a failure the user hears about, not silence", async () => {
    const { emit, state } = await summoned({
      hands: {
        async ask() {
          throw new Error("the Hands session was still working after 120 seconds");
        },
        async end() {},
      },
    });

    await steer(emit, { session: "demo-t23", instruction: "rebase first" });

    const answer = outputFor(state.toolResults, "st1");
    expect(answer.status).toBe("failed");
    expect(answer.reason).toContain("still working");
  });
});

describe("which sessions a Summons may steer", () => {
  function harness(
    sessions: { name: string; kind: "worker" | "hands" | "other"; ticket: number | null }[],
    claims: Record<number, string | null> = {},
    claimKnown = true,
  ) {
    const asked: string[] = [];
    const comments: { ticket: number; body: string }[] = [];
    const { transport, state, emit } = fakeTransport();
    const started = createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions: fakeActions().actions,
      sessions: {
        list: async () => ({
          known: true,
          sessions: sessions.map((s, at) => ({ ...s, status: "busy", pid: 100 + at })),
        }),
      },
      hands: {
        async ask(request) {
          asked.push(request);
          return "SERVANT-STEER: delivered";
        },
        async end() {},
      },
      tickets: {
        async claim(ticket) {
          return claimKnown ? { known: true, session: claims[ticket] ?? null } : { known: false };
        },
        async comment(ticket, body) {
          comments.push({ ticket, body });
        },
      },
      instructions: "hi",
    }).start();
    return started.then(() => ({ state, emit, asked, comments }));
  }

  const steer = (
    emit: (e: RealtimeInbound) => Promise<void>,
    args: Record<string, unknown>,
    callId = "st1",
  ) => emit({ type: "tool_call", callId, name: "steer_session", args: JSON.stringify(args) });

  const worker = (name: string, ticket: number) => ({ name, kind: "worker" as const, ticket });

  // AC 4. A session the user started by hand carries no ticket, so nothing says it is theirs to
  // redirect — it is nameable and deliberately not addressable.
  test("a session holding no Claim is not addressable, and the agent is told why", async () => {
    const { state, emit, asked } = await harness([
      { name: "demo-scratch", kind: "other", ticket: null },
    ]);

    await steer(emit, { session: "demo-scratch", instruction: "rebase first" });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").error).toContain("no ticket");
  });

  test("a Worker whose ticket somebody else claimed is not addressable", async () => {
    const { state, emit, asked } = await harness([worker("demo-t23", 23)], {
      23: "demo-t23-redo",
    });

    await steer(emit, { session: "demo-t23", instruction: "rebase first" });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").error).toContain("demo-t23-redo");
  });

  test("a Worker on a ticket nobody has claimed is not addressable", async () => {
    const { state, emit, asked } = await harness([worker("demo-t23", 23)], { 23: null });

    await steer(emit, { session: "demo-t23", instruction: "rebase first" });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").error).toContain("Nobody holds the Claim");
  });

  // Fail closed: a hub we could not reach must never be read as a ticket nobody has claimed.
  test("a hub that could not be reached refuses the steer rather than waving it through", async () => {
    const { state, emit, asked } = await harness([worker("demo-t23", 23)], {}, false);

    await steer(emit, { session: "demo-t23", instruction: "rebase first" });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").error).toContain("could not be reached");
  });

  // AC 5. The registry read is scoped to this workspace's directory, so another project's session
  // is not in the list at all — there is no name here that could reach it.
  test("a session in another workspace is not reachable, and cannot be named into reach", async () => {
    const { state, emit, asked } = await harness([worker("demo-t23", 23)], { 23: "demo-t23" });

    await steer(emit, { session: "otherproject-t5", instruction: "rebase first" });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").error).toContain("other workspaces");
  });

  test("an unreadable registry refuses rather than guessing at a name", async () => {
    const { transport, state, emit } = fakeTransport();
    const asked: string[] = [];
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      sessions: { list: async () => ({ known: false }) },
      hands: {
        async ask(r) {
          asked.push(r);
          return "SERVANT-STEER: delivered";
        },
        async end() {},
      },
      tickets: {
        async claim() {
          return { known: false };
        },
        async comment() {},
      },
      instructions: "hi",
    }).start();

    await steer(emit, { instruction: "rebase first" });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").error).toContain("could not be read");
  });

  test("the ticket number is a name too, since that is what the user says out loud", async () => {
    const { emit, asked } = await harness([worker("demo-t23", 23)], { 23: "demo-t23" });

    await steer(emit, { session: "#23", instruction: "rebase first" });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("demo-t23");
  });

  // AC 11.
  test("with several claimed sessions running, an unqualified instruction asks which one", async () => {
    const { state, emit, asked } = await harness([worker("demo-t23", 23), worker("demo-t26", 26)], {
      23: "demo-t23",
      26: "demo-t26",
    });

    await steer(emit, { instruction: "rebase first" });

    expect(asked).toEqual([]);
    const answer = outputFor(state.toolResults, "st1");
    expect(answer.needs_disambiguation).toBe(true);
    expect(answer.sessions.map((s: { session: string }) => s.session)).toEqual([
      "demo-t23",
      "demo-t26",
    ]);
    expect(answer.instruction).toContain("Do not guess");
  });

  test("with only one session running, an unqualified instruction goes to it", async () => {
    const { emit, asked } = await harness([worker("demo-t23", 23)], { 23: "demo-t23" });

    await steer(emit, { instruction: "rebase first" });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("demo-t23");
  });

  // The hands are reachable by name, but "steer it" means the work, not the errand-runner.
  test("the conversation's own hands are never what an unqualified instruction means", async () => {
    const { state, emit, asked } = await harness([
      { name: "demo-hands", kind: "hands", ticket: null },
    ]);

    await steer(emit, { instruction: "rebase first" });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").error).toContain("No session is running");
  });
});

describe("what a steer writes down", () => {
  function harness() {
    const asked: string[] = [];
    const comments: { ticket: number; body: string }[] = [];
    const { transport, state, emit } = fakeTransport();
    return createSummonsSession({
      transport,
      reader: fakeReader().reader,
      sessions: {
        list: async () => ({
          known: true,
          sessions: [
            { name: "demo-t23", kind: "worker" as const, ticket: 23, status: "busy", pid: 1 },
          ],
        }),
      },
      hands: {
        async ask(request) {
          asked.push(request);
          return "SERVANT-STEER: delivered";
        },
        async end() {},
      },
      tickets: {
        async claim() {
          return { known: true, session: "demo-t23" };
        },
        async comment(ticket, body) {
          comments.push({ ticket, body });
        },
      },
      instructions: "hi",
    })
      .start()
      .then(() => ({ state, emit, asked, comments }));
  }

  const steer = (
    emit: (e: RealtimeInbound) => Promise<void>,
    args: Record<string, unknown>,
    callId = "st1",
  ) => emit({ type: "tool_call", callId, name: "steer_session", args: JSON.stringify(args) });

  // AC 6 and AC 9 together: the ordinary case is silent and leaves no trace on the ticket.
  test("a routine redirect goes straight out, with no confirmation asked for", async () => {
    const { state, emit, asked } = await harness();

    await steer(emit, { instruction: "also check the tests before you push" });

    expect(asked).toHaveLength(1);
    expect(state.notes).toEqual([]);
    expect(outputFor(state.toolResults, "st1").status).toBe("delivered");
  });

  test("a routine redirect writes nothing to the ticket — the transcripts already have it twice", async () => {
    const { emit, comments } = await harness();

    await steer(emit, { instruction: "use a map instead of the array scan" });

    expect(comments).toEqual([]);
  });

  // AC 10. This one outlives the session, so it goes where the session does not.
  test("an instruction that changes what done means is written to the ticket", async () => {
    const { emit, comments } = await harness();

    await steer(emit, {
      instruction: "it also has to work when the registry is unreadable",
      changes_acceptance_criteria: true,
    });

    expect(comments).toHaveLength(1);
    expect(comments[0]?.ticket).toBe(23);
    expect(comments[0]?.body).toContain("it also has to work when the registry is unreadable");
    expect(comments[0]?.body).toContain("demo-t23");
  });

  test("nothing is written to the ticket for an instruction that never reached the session", async () => {
    const comments: { ticket: number; body: string }[] = [];
    const { transport, state, emit } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      sessions: {
        list: async () => ({
          known: true,
          sessions: [
            { name: "demo-t23", kind: "worker" as const, ticket: 23, status: "busy", pid: 1 },
          ],
        }),
      },
      hands: {
        async ask() {
          return "SERVANT-STEER: failed — no such session";
        },
        async end() {},
      },
      tickets: {
        async claim() {
          return { known: true, session: "demo-t23" };
        },
        async comment(ticket, body) {
          comments.push({ ticket, body });
        },
      },
      instructions: "hi",
    }).start();

    await steer(emit, {
      instruction: "drop the cache entirely",
      changes_acceptance_criteria: true,
    });

    expect(outputFor(state.toolResults, "st1").status).toBe("failed");
    expect(comments).toEqual([]);
  });
});

describe("stopping a session is Guarded", () => {
  function harness() {
    const asked: string[] = [];
    const { transport, state, emit } = fakeTransport();
    return createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions: fakeActions().actions,
      sessions: {
        list: async () => ({
          known: true,
          sessions: [
            { name: "demo-t23", kind: "worker" as const, ticket: 23, status: "busy", pid: 1 },
          ],
        }),
      },
      hands: {
        async ask(request) {
          asked.push(request);
          return "SERVANT-STEER: delivered";
        },
        async end() {},
      },
      tickets: {
        async claim() {
          return { known: true, session: "demo-t23" };
        },
        async comment() {},
      },
      instructions: "hi",
    })
      .start()
      .then(() => ({ state, emit, asked }));
  }

  const stop = (
    emit: (e: RealtimeInbound) => Promise<void>,
    args: Record<string, unknown> = {},
    callId = "sp1",
  ) => emit({ type: "tool_call", callId, name: "stop_session", args: JSON.stringify(args) });

  const steer = (
    emit: (e: RealtimeInbound) => Promise<void>,
    args: Record<string, unknown>,
    callId = "st1",
  ) => emit({ type: "tool_call", callId, name: "steer_session", args: JSON.stringify(args) });

  test("asking to stop sends nothing and comes back asking to confirm", async () => {
    const { state, emit, asked } = await harness();

    await stop(emit, { session: "demo-t23", reason: "we are going a different way" });

    expect(asked).toEqual([]);
    const answer = outputFor(state.toolResults, "sp1");
    expect(answer.status).toBe("awaiting_confirmation");
    expect(answer.instruction).toContain("yes or no");
    expect(answer.instruction).toContain("may be lost");
  });

  test("a spoken yes sends it", async () => {
    const { emit, asked } = await harness();
    await stop(emit, { session: "demo-t23" });

    await emit({ type: "user_transcript", text: "Yes, go ahead.", itemId: "item_2" });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("demo-t23");
  });

  // A sharp edge worth knowing about: "yes, stop it" is the most natural thing to say here, and
  // the classifier reads it as neither — "stop" is one of the words it treats as a decline. It
  // declines, which is the safe direction, and the agent asks for a plain yes. Deliberately not
  // loosened: the classifier is strict on purpose, and this is the action that destroys work.
  test("'yes, stop it' is not a clear yes — it declines and asks again", async () => {
    const { state, emit, asked } = await harness();
    await stop(emit, { session: "demo-t23" });

    await emit({ type: "user_transcript", text: "Yes, stop it.", itemId: "item_2" });

    expect(asked).toEqual([]);
    expect(state.notes.join(" ")).toContain("Ask again");
  });

  test("a spoken no sends nothing", async () => {
    const { state, emit, asked } = await harness();
    await stop(emit, { session: "demo-t23" });

    await emit({ type: "user_transcript", text: "No.", itemId: "item_2" });

    expect(asked).toEqual([]);
    expect(state.notes.join(" ")).toContain("declined");
    expect(state.notes.join(" ")).toContain("still running");
  });

  // Caught by a live run, not by this file: "no, leave it running" is the natural way to decline,
  // and the classifier reads it as *unclear* rather than negative — "no" and "leave it" are both
  // decline phrases but "running" is left over, and it only accepts an utterance made entirely of
  // them. Nothing is sent either way, which is what matters; the agent just asks again instead of
  // moving on. Pinned rather than loosened, for the same reason as "yes, stop it" above.
  test("'no, leave it running' declines too, by the unclear route", async () => {
    const { state, emit, asked } = await harness();
    await stop(emit, { session: "demo-t23" });

    await emit({ type: "user_transcript", text: "no, leave it running", itemId: "item_2" });

    expect(asked).toEqual([]);
    expect(state.notes.join(" ")).toContain("Ask again");
  });

  test("an ambiguous answer declines it — a misheard sentence must not destroy work", async () => {
    const { state, emit, asked } = await harness();
    await stop(emit, { session: "demo-t23" });

    await emit({ type: "user_transcript", text: "hang on, what?", itemId: "item_2" });

    expect(asked).toEqual([]);
    expect(state.notes.join(" ")).toContain("Ask again");
  });

  // The separate tool is a signpost, not a fence: a model can always phrase a stop as a redirect.
  test("a stop phrased as a redirect is still held at the gate", async () => {
    const { state, emit, asked } = await harness();

    await steer(emit, {
      session: "demo-t23",
      instruction: "stop what you are doing and stand down",
    });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").status).toBe("awaiting_confirmation");
  });

  test("a redirect that merely mentions stopping something is not held", async () => {
    const { emit, asked } = await harness();

    await steer(emit, { session: "demo-t23", instruction: "stop using the old parser" });

    expect(asked).toHaveLength(1);
  });

  // One gate for the whole conversation: two things waiting on "yes" is a yes with no referent.
  test("a stop cannot be proposed while a delegation is already waiting on an answer", async () => {
    const { state, emit } = await harness();
    await emit({
      type: "tool_call",
      callId: "d1",
      name: "delegate",
      args: JSON.stringify({ task: "refactor auth", label: "auth" }),
    });

    await stop(emit, { session: "demo-t23" });

    expect(outputFor(state.toolResults, "sp1").error).toContain("waiting on a yes or no");
  });
});

// Both found in review, and both are the same shape of bug: a fact about one action leaking into
// another because the gate and the ticket note were reasoning about the wrong thing.
describe("holes review found in steering", () => {
  function harness(reply = "SERVANT-STEER: delivered") {
    const asked: string[] = [];
    const comments: { ticket: number; body: string }[] = [];
    const { transport, state, emit } = fakeTransport();
    return createSummonsSession({
      transport,
      reader: fakeReader().reader,
      actions: fakeActions().actions,
      sessions: {
        list: async () => ({
          known: true,
          sessions: [
            { name: "demo-t23", kind: "worker" as const, ticket: 23, status: "busy", pid: 1 },
          ],
        }),
      },
      hands: {
        async ask(request) {
          asked.push(request);
          return reply;
        },
        async end() {},
      },
      tickets: {
        async claim() {
          return { known: true, session: "demo-t23" };
        },
        async comment(ticket, body) {
          comments.push({ ticket, body });
        },
      },
      instructions: "hi",
    })
      .start()
      .then(() => ({ state, emit, asked, comments }));
  }

  const steer = (
    emit: (e: RealtimeInbound) => Promise<void>,
    args: Record<string, unknown>,
    callId = "st1",
  ) => emit({ type: "tool_call", callId, name: "steer_session", args: JSON.stringify(args) });

  const stop = (emit: (e: RealtimeInbound) => Promise<void>, callId = "sp1") =>
    emit({
      type: "tool_call",
      callId,
      name: "stop_session",
      args: JSON.stringify({ session: "demo-t23" }),
    });

  // The gate holds one thing at a time, so a "yes" has one referent. A steer accepted while a stop
  // waits would put a second question in the air, and the user's yes — meant for the steer — would
  // release the stop. That is a session destroyed on a confirmation nobody gave.
  test("a steer cannot be issued while a stop is waiting on an answer", async () => {
    const { state, emit, asked } = await harness();
    await stop(emit);

    await steer(emit, { instruction: "also check the tests" });

    expect(asked).toEqual([]);
    expect(outputFor(state.toolResults, "st1").error).toContain("waiting on a yes or no");
  });

  test("and the yes that follows still resolves the stop it was asked about", async () => {
    const { emit, asked } = await harness();
    await stop(emit);
    await steer(emit, { instruction: "also check the tests" });

    await emit({ type: "user_transcript", text: "yes", itemId: "item_2" });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("stand down");
  });

  // AC 10 against the unconfirmed case. The note outlives the session; dropping it because the
  // relay went quiet rounds "unconfirmed" down to "failed", which is the conflation this feature
  // exists to avoid — and the send may well have landed.
  test("a criteria change is written to the ticket even when delivery was unconfirmed", async () => {
    const { emit, comments } = await harness("I passed it along.");

    await steer(emit, {
      instruction: "it also has to work when the registry is unreadable",
      changes_acceptance_criteria: true,
    });

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("it also has to work when the registry is unreadable");
    // ...and the note says so, rather than reading as a change that certainly landed.
    expect(comments[0]?.body.toLowerCase()).toContain("not confirmed");
  });

  test("a steer that outright failed still writes nothing to the ticket", async () => {
    const { emit, comments } = await harness("SERVANT-STEER: failed — no such session");

    await steer(emit, {
      instruction: "drop the cache entirely",
      changes_acceptance_criteria: true,
    });

    expect(comments).toEqual([]);
  });

  // A refused steer leaves no `steer` record, so without this it leaves no trace at all — and the
  // Call log's whole promise is that nothing the agent does on the user's behalf is invisible.
  test("a steer that was refused still shows up in the Call log", async () => {
    const recorded: { type: string }[] = [];
    const { transport, emit } = fakeTransport();
    await createSummonsSession({
      transport,
      reader: fakeReader().reader,
      sessions: { list: async () => ({ known: true, sessions: [] }) },
      hands: {
        async ask() {
          return "SERVANT-STEER: delivered";
        },
        async end() {},
      },
      tickets: {
        async claim() {
          return { known: true, session: null };
        },
        async comment() {},
      },
      callLog: { record: (entry) => recorded.push(entry) },
      instructions: "hi",
    }).start();

    await steer(emit, { session: "demo-t99", instruction: "rebase first" });

    expect(recorded.map((e) => e.type)).toContain("tool");
  });
});
