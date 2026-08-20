import { describe, expect, test } from "bun:test";
import {
  composeSessionUpdate,
  createOpenAiRealtimeTransport,
  toInbound,
} from "../src/core/summons-realtime.ts";
import {
  DEFAULT_SUMMONS_MODEL,
  DEFAULT_SUMMONS_VOICE,
  type RealtimeInbound,
} from "../src/core/summons.ts";

describe("Realtime server events the controller acts on", () => {
  test("model speech becomes playable audio, tagged with the reply it belongs to", () => {
    expect(
      toInbound({ type: "response.output_audio.delta", delta: "c3BlZWNo", item_id: "item_7" }),
    ).toEqual({
      type: "audio",
      pcm: "c3BlZWNo",
      itemId: "item_7",
    });
  });

  test("voice-activity detection becomes a user-speaking signal", () => {
    expect(toInbound({ type: "input_audio_buffer.speech_started", item_id: "item_1" })).toEqual({
      type: "user_speaking",
      itemId: "item_1",
    });
  });

  test("the user's own words come through, tagged with the utterance they belong to", () => {
    expect(
      toInbound({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item_2",
        transcript: "yes, go ahead",
      }),
    ).toEqual({ type: "user_transcript", text: "yes, go ahead", itemId: "item_2" });
  });

  test("a finished function call becomes a tool call", () => {
    expect(
      toInbound({
        type: "response.function_call_arguments.done",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"GOAL.md"}',
      }),
    ).toEqual({
      type: "tool_call",
      callId: "call_1",
      name: "read_file",
      args: '{"path":"GOAL.md"}',
    });
  });

  test("the model's own words come through as a transcript", () => {
    expect(
      toInbound({ type: "response.output_audio_transcript.done", transcript: "it says ship it" }),
    ).toEqual({ type: "assistant_transcript", text: "it says ship it" });
  });

  test("an API error surfaces its message", () => {
    expect(toInbound({ type: "error", error: { message: "invalid_api_key" } })).toEqual({
      type: "error",
      message: "invalid_api_key",
    });
  });

  // Not "the reply is over" — there can be a minute of it still queued to play. It says only that
  // there is nothing left to cancel, which is what keeps a late barge-in from erroring.
  test("a reply finishing generating comes through, since cancelling it afterwards would error", () => {
    expect(toInbound({ type: "response.done" })).toEqual({ type: "reply_done" });
  });

  // The other bracket. A reply is cancellable from here, which is well before its first audio —
  // so an interruption arriving in that window has something to cancel after all.
  test("a reply starting comes through, since that is when it becomes cancellable", () => {
    expect(toInbound({ type: "response.created" })).toEqual({ type: "reply_started" });
  });

  test("events the controller has no opinion about are ignored", () => {
    expect(toInbound({ type: "session.updated" })).toBeNull();
    expect(toInbound({ type: "rate_limits.updated" })).toBeNull();
    expect(toInbound("not an event")).toBeNull();
  });
});

describe("the session the transport opens", () => {
  const spec = {
    model: DEFAULT_SUMMONS_MODEL,
    voice: DEFAULT_SUMMONS_VOICE,
    instructions: "hi",
    tools: [],
  };

  test("the server never interrupts its own reply — the controller decides that", () => {
    const update = composeSessionUpdate(spec) as {
      session: { audio: { input: { turn_detection: Record<string, unknown> } } };
    };

    const detection = update.session.audio.input.turn_detection;
    // Hands-free still means the server ends the user's turn and starts the reply...
    expect(detection.type).toBe("server_vad");
    expect(detection.create_response).not.toBe(false);
    // ...but cutting a reply off is a client decision, because the client is the only side that
    // knows whether the mic was even open, and it is the side holding the queued audio to flush.
    expect(detection.interrupt_response).toBe(false);
  });
});

/**
 * A socket that never opens, never errors and never closes — and one that opens and then goes
 * quiet. Neither is reachable through a real WebSocket without a network, so the transport takes
 * its socket and its clock from outside, and both are driven by hand here.
 */
function fakeSocket() {
  const listeners = new Map<string, ((event: SocketEventLike) => void)[]>();
  const sent: unknown[] = [];
  const socket = {
    readyState: 1,
    pings: 0,
    closed: false,
    send: (data: string) => void sent.push(JSON.parse(data)),
    close: () => {
      socket.closed = true;
    },
    ping: () => {
      socket.pings += 1;
    },
    addEventListener: (type: string, listener: (event: SocketEventLike) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  return {
    socket,
    sent,
    fire: (type: string, event: SocketEventLike = {}) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

interface SocketEventLike {
  data?: unknown;
  code?: number;
  reason?: string;
}

/** A clock nothing waits on: time only moves when a test says so, and due timers fire then. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    port: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const handle = next++;
        due.set(handle, { at: now + ms, fn });
        return handle;
      },
      clearTimeout: (handle: unknown) => void due.delete(handle as number),
    },
    advance(ms: number) {
      const until = now + ms;
      // One at a time and re-read each pass, because a timer that fires may schedule the next one.
      for (;;) {
        const ready = [...due.entries()]
          .filter(([, timer]) => timer.at <= until)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (!ready) break;
        due.delete(ready[0]);
        now = ready[1].at;
        ready[1].fn();
      }
      now = until;
    },
  };
}

const SPEC = {
  model: DEFAULT_SUMMONS_MODEL,
  voice: DEFAULT_SUMMONS_VOICE,
  instructions: "hi",
  tools: [],
};

function connectFake(overrides: Record<string, number> = {}) {
  const fake = fakeSocket();
  const timers = fakeTimers();
  const inbound: RealtimeInbound[] = [];
  const transport = createOpenAiRealtimeTransport("key", {
    openSocket: () => fake.socket,
    timers: timers.port,
    handshakeTimeoutMs: 15_000,
    heartbeatMs: 20_000,
    silenceTimeoutMs: 60_000,
    ...overrides,
  });
  const connected = transport.connect(SPEC, (event) => {
    inbound.push(event);
    return Promise.resolve();
  });
  return { fake, timers, inbound, transport, connected };
}

describe("a handshake that never finishes", () => {
  test("a socket that neither opens nor errors gives up and says so, instead of hanging forever", async () => {
    const { timers, connected } = connectFake();
    let settled = "pending";
    void connected.then(
      () => (settled = "resolved"),
      (err: Error) => (settled = err.message),
    );

    timers.advance(14_000);
    await Promise.resolve();
    expect(settled).toBe("pending");

    timers.advance(2_000);
    await Promise.resolve();
    expect(settled).toContain("did not answer within 15s");
  });

  test("a socket closed before the session opened is a failure to connect, not a hang-up", async () => {
    const { fake, connected, inbound } = connectFake();
    const failure = connected.catch((err: Error) => err.message);
    fake.fire("close", { code: 1006 });
    expect(await failure).toContain("closed the connection before the session opened");
    // Nothing to hang up — the controller was never told a session existed.
    expect(inbound).toEqual([]);
  });
});

describe("a socket that has gone quiet", () => {
  test("a live socket is pinged, and what answers keeps it alive", async () => {
    const { fake, timers, connected, inbound } = connectFake();
    fake.fire("open");
    await connected;

    for (let minute = 0; minute < 5; minute++) {
      timers.advance(20_000);
      fake.fire("pong");
    }

    expect(fake.socket.pings).toBe(5);
    expect(inbound).toEqual([]);
    expect(fake.socket.closed).toBe(false);
  });

  test("a half-open socket ends the call, rather than leaving the mic streaming into nothing", async () => {
    const { fake, timers, connected, inbound } = connectFake();
    fake.fire("open");
    await connected;

    // One answered ping, so this endpoint is known to answer them...
    timers.advance(20_000);
    fake.fire("pong");
    // ...and then, with no close and no error, the connection simply stops answering — which is
    // what a wifi flap or a sleeping laptop leaves behind.
    timers.advance(60_000);

    expect(inbound[0]).toEqual({
      type: "error",
      message: "the connection to the Realtime API went quiet for 60s — hanging up.",
    });
    expect(inbound[1]).toEqual({ type: "closed" });
    expect(fake.socket.closed).toBe(true);
  });

  test("an endpoint that never answers a ping is left to the idle timer, not hung up on", async () => {
    const { fake, timers, connected, inbound } = connectFake();
    fake.fire("open");
    await connected;

    // Quiet for ten minutes, and not one pong in reply — but silence from an endpoint that has
    // never answered a ping is not evidence of anything.
    timers.advance(600_000);

    expect(inbound).toEqual([]);
    expect(fake.socket.closed).toBe(false);
  });

  test("the call ends once, however many frames find the socket gone", async () => {
    const { fake, timers, transport, connected, inbound } = connectFake();
    fake.fire("open");
    await connected;
    timers.advance(20_000);
    fake.fire("pong");
    timers.advance(60_000);

    transport.sendAudio("c3BlZWNo");
    transport.sendAudio("c3BlZWNo");
    fake.fire("close", { code: 1006 });

    expect(inbound.filter((event) => event.type === "closed")).toHaveLength(1);
  });
});

describe("sending on a socket that is not open", () => {
  test("a mic frame with nowhere to go ends the call, instead of vanishing", async () => {
    const { fake, transport, connected, inbound } = connectFake();
    fake.fire("open");
    await connected;

    // CLOSING. A real `socket.send` here discards the payload and says nothing, which is how a
    // Summons went on listening to a user whose voice was reaching nobody.
    fake.socket.readyState = 2;
    transport.sendAudio("c3BlZWNo");

    expect(inbound).toEqual([
      { type: "error", message: "the connection to the Realtime API is gone — hanging up." },
      { type: "closed" },
    ]);
  });

  test("a send that throws ends the call, quoting what the socket said", async () => {
    const { fake, transport, connected, inbound } = connectFake();
    fake.fire("open");
    await connected;

    fake.socket.send = () => {
      throw new Error("socket is closed");
    };
    transport.cancelResponse();

    expect(inbound[0]).toEqual({
      type: "error",
      message: "the connection to the Realtime API failed: socket is closed",
    });
  });
});

describe("hanging up", () => {
  test("a deliberate hang-up is not reported as a failure", async () => {
    const { fake, timers, transport, connected, inbound } = connectFake();
    fake.fire("open");
    await connected;

    await transport.close();
    fake.fire("close", { code: 1000 });
    timers.advance(120_000);

    expect(inbound).toEqual([]);
    expect(fake.socket.closed).toBe(true);
  });
});

describe("a typed utterance", () => {
  test("goes in as a user turn and asks for the reply out loud", async () => {
    const { fake, transport, connected } = connectFake();
    fake.fire("open");
    await connected;
    const from = fake.sent.length;

    transport.sendUserText("actually check ticket 3");

    expect(fake.sent.slice(from)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "actually check ticket 3" }],
        },
      },
      { type: "response.create" },
    ]);
  });

  // The distinction the two primitives exist for: a note lands in a reply already under way, so
  // asking for a second one would collide with it. A typed turn has no reply coming.
  test("a note is the other thing — a system message, and no reply asked for", async () => {
    const { fake, transport, connected } = connectFake();
    fake.fire("open");
    await connected;
    const from = fake.sent.length;

    transport.sendAgentNote("the user said yes");

    expect(fake.sent.slice(from)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "the user said yes" }],
        },
      },
    ]);
  });
});
