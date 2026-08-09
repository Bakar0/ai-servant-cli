import { describe, expect, test } from "bun:test";
import {
  type AudioPort,
  type DelegationReport,
  type DelegationRequest,
  type HandsPort,
  type RealtimeInbound,
  type RealtimeSessionSpec,
  type RealtimeTransport,
  type SummonsActions,
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
    sendToolResult(callId, output) {
      state.toolResults.push({ callId, output });
    },
    sendAgentNote(text) {
      state.notes.push(text);
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
      sendToolResult() {},
      sendAgentNote() {},
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
      sendToolResult() {},
      sendAgentNote() {},
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
  /** A hand-driven clock, so playback timing is asserted without waiting in real time. */
  function fakeClock() {
    let t = 1_000;
    const timers: TimerPort = {
      now: () => t,
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
    return { timers, advance: (ms: number) => (t += ms) };
  }

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
});
