import { describe, expect, test } from "bun:test";
import {
  type AudioPort,
  type RealtimeInbound,
  type RealtimeSessionSpec,
  type RealtimeTransport,
  type TimerPort,
  type WorkspaceReader,
  createTalkSession,
} from "../src/core/talk.ts";
import { requireAudioTool, requireOpenAiApiKey } from "../src/core/talk-preflight.ts";

/** A fake Realtime transport: records what the controller sent, replays scripted inbound events. */
function fakeTransport() {
  let emit: (event: RealtimeInbound) => Promise<void> = async () => {};
  const state = {
    spec: null as RealtimeSessionSpec | null,
    audioSent: [] as string[],
    toolResults: [] as { callId: string; output: string }[],
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

describe("talk session startup", () => {
  test("connects with the assembled instructions and the configured voice and model", async () => {
    const { transport, state } = fakeTransport();
    const session = createTalkSession({
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
    await createTalkSession({ transport, reader: fakeReader().reader, instructions: "hi" }).start();

    expect(state.spec?.model).toBe("gpt-realtime");
    expect(state.spec?.voice).toBe("marin");
  });

  test("offers only read-only tools — no edit, write or run-command tool", async () => {
    const { transport, state } = fakeTransport();
    await createTalkSession({ transport, reader: fakeReader().reader, instructions: "hi" }).start();

    const names = (state.spec?.tools ?? []).map((t) => t.name).toSorted();
    expect(names).toEqual(["glob", "grep", "read_file"]);
  });
});

describe("talk session tool calls", () => {
  async function started(readerOverrides: Partial<WorkspaceReader> = {}) {
    const { transport, state, emit } = fakeTransport();
    const { reader, asked } = fakeReader(readerOverrides);
    const session = createTalkSession({ transport, reader, instructions: "hi" });
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

describe("talk session audio", () => {
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
    await createTalkSession({
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
    await createTalkSession({
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
    const session = createTalkSession({
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

describe("talk session idle hang-up", () => {
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
    const session = createTalkSession({
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
    const session = createTalkSession({
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

describe("talk preflight", () => {
  test("a missing audio tool is reported with an install hint", () => {
    expect(() => requireAudioTool(() => null)).toThrow(/brew install sox/);
    expect(requireAudioTool(() => "/opt/homebrew/bin/sox")).toBe("/opt/homebrew/bin/sox");
  });
});

describe("talk session failures the user can hear about", () => {
  test("an API error is surfaced rather than leaving a silent open mic", async () => {
    const { transport, emit } = fakeTransport();
    const errors: string[] = [];
    await createTalkSession({
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
    const session = createTalkSession({
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
      async close() {
        events.push("socket-closed");
      },
    };

    await createTalkSession({
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
      async close() {
        events.push("socket-closed");
      },
    };

    await createTalkSession({
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
    const session = createTalkSession({
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
