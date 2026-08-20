import {
  realTimers,
  type RealtimeInbound,
  type RealtimeSessionSpec,
  type RealtimeTransport,
  type TimerPort,
} from "./summons.ts";

// The OpenAI Realtime transport: one WebSocket carrying native speech-to-speech in both directions,
// so there is no STT/TTS pipeline in the path (workspace ADR 0009). This is the seam's outside —
// it translates wire events into the handful the controller reasons about and nothing more.

const REALTIME_URL = "wss://api.openai.com/v1/realtime";

/** `WebSocket.OPEN`, spelled out so a fake socket need only be a plain object. */
const SOCKET_OPEN = 1;

/**
 * How long the handshake may take before the Summons gives up and says why.
 *
 * A socket that neither opens nor errors — a stalled TLS handshake, a black-holed connection —
 * used to leave `connect()` pending forever, and `servant summon` hung before it had printed
 * anything at all.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** How often a socket with nothing to say is pinged, to prove it is still there. */
const HEARTBEAT_MS = 20_000;

/**
 * How long a socket may say nothing whatsoever — not a message, not a pong — before it is treated
 * as gone.
 *
 * The failure this exists for is the half-open socket: wifi flaps or the laptop sleeps, and the
 * connection dies without either side sending a FIN. No `close` event ever fires, so the mic goes
 * on streaming into a socket nobody is reading, the call looks alive, and the only thing that ends
 * it is the idle timer three minutes later. Three missed pings is the evidence; the call ends on it.
 */
const SILENCE_TIMEOUT_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Translate a Realtime server event into the controller's vocabulary, or null to ignore it. */
export function toInbound(event: unknown): RealtimeInbound | null {
  const e = asRecord(event);
  switch (str(e.type)) {
    case "response.output_audio.delta":
      return { type: "audio", pcm: str(e.delta), itemId: str(e.item_id) || undefined };
    case "input_audio_buffer.speech_started":
      return { type: "user_speaking", itemId: str(e.item_id) || undefined };
    case "conversation.item.input_audio_transcription.completed":
      return {
        type: "user_transcript",
        text: str(e.transcript),
        itemId: str(e.item_id) || undefined,
      };
    case "response.function_call_arguments.done":
      return {
        type: "tool_call",
        callId: str(e.call_id),
        name: str(e.name),
        args: str(e.arguments),
      };
    case "response.output_audio_transcript.done":
      return { type: "assistant_transcript", text: str(e.transcript) };
    case "response.created":
      return { type: "reply_started" };
    case "response.done":
      return { type: "reply_done" };
    case "error":
      return { type: "error", message: str(asRecord(e.error).message) || "Realtime error" };
    default:
      return null;
  }
}

export function composeSessionUpdate(spec: RealtimeSessionSpec): unknown {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: spec.model,
      instructions: spec.instructions,
      audio: {
        // Server-side voice-activity detection is what makes the session hands-free: the model
        // decides when a turn ends, so no key is ever held or pressed to talk.
        //
        // Native speech-to-speech needs no transcription to *understand* the user — this is asked
        // for so the controller can read the spoken yes or no that releases a Guarded delegation.
        // Without it the confirm-gate would have nothing to judge but the model's own say-so.
        input: {
          turn_detection: {
            type: "server_vad",
            // The server must not cut off its own reply. On speakers the mic is gated against
            // echo, so the server cannot see the interruption at all — and it is the client that
            // holds the queued audio which has to be flushed.
            interrupt_response: false,
          },
          transcription: { model: "gpt-4o-mini-transcribe" },
        },
        output: { voice: spec.voice },
      },
      tools: spec.tools.map((tool) => ({ type: "function", ...tool })),
      tool_choice: "auto",
    },
  };
}

/** What a socket event carries, of the little this transport reads off it. */
interface SocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

/**
 * The socket, as this transport needs it. The seam exists so the suite can drive a handshake that
 * never completes and a connection that goes quiet — neither of which is reachable through a real
 * WebSocket without a network.
 */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  /** Bun's client sockets can ping, and answer with a `pong` event. That is the whole heartbeat. */
  ping?: (() => void) | undefined;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
}

export interface RealtimeTransportOptions {
  onDebug?: ((message: string) => void) | undefined;
  openSocket?: ((url: string) => RealtimeSocket) | undefined;
  timers?: TimerPort | undefined;
  handshakeTimeoutMs?: number | undefined;
  heartbeatMs?: number | undefined;
  silenceTimeoutMs?: number | undefined;
}

export function createOpenAiRealtimeTransport(
  apiKey: string,
  opts: RealtimeTransportOptions = {},
): RealtimeTransport {
  const timers = opts.timers ?? realTimers;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const silenceTimeoutMs = opts.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
  const open =
    opts.openSocket ??
    ((url: string) =>
      new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }) as unknown as RealtimeSocket);

  let socket: RealtimeSocket | null = null;
  let deliver: ((event: RealtimeInbound) => void) | null = null;
  let heartbeat: unknown = null;
  /** When this socket last proved it was alive — any message, or a pong to one of our pings. */
  let lastHeard = 0;
  /**
   * The socket is done with, whether it was hung up on or given up on. Everything that could report
   * a dead socket checks this, so a call ends once and is described once — the mic sends five frames
   * a second, and each of them finding the socket gone is not five failures.
   */
  let finished = false;
  /**
   * Whether this endpoint has ever answered a ping.
   *
   * Silence only means death on a socket whose pongs we have seen. Reading it as death on an
   * endpoint that simply does not answer pings would hang up on a healthy call after a minute of
   * the user not talking — a worse bug than the one this detector is here for, and one the idle
   * timer would have handled correctly on its own.
   */
  let answersPings = false;

  function stopHeartbeat(): void {
    timers.clearTimeout(heartbeat);
    heartbeat = null;
  }

  /**
   * End the call on a socket that cannot carry it, saying why first.
   *
   * `error` then `closed`, because those are the two things the controller already knows how to do
   * with a dying session: the first is what the user hears about, the second is what hangs up.
   */
  function giveUp(why: string): void {
    if (finished) return;
    finished = true;
    stopHeartbeat();
    const dying = socket;
    socket = null;
    dying?.close();
    deliver?.({ type: "error", message: why });
    deliver?.({ type: "closed" });
  }

  /** Ping a quiet socket, and give up on one that has not answered in far too long. */
  function beat(): void {
    heartbeat = timers.setTimeout(() => {
      if (finished) return;
      const quiet = timers.now() - lastHeard;
      if (answersPings && quiet >= silenceTimeoutMs) {
        giveUp(
          `the connection to the Realtime API went quiet for ${Math.round(quiet / 1000)}s — hanging up.`,
        );
        return;
      }
      socket?.ping?.();
      opts.onDebug?.(`socket: pinged after ${Math.round(quiet / 1000)}s of quiet`);
      beat();
    }, heartbeatMs);
  }

  // Silently discarding this is what a `socket?.send(...)` on a closing socket did, and a mic frame
  // or a tool result going nowhere without a word is the same invisible failure as the socket that
  // never closes.
  function send(payload: unknown): void {
    if (finished) return;
    const sock = socket;
    if (!sock || sock.readyState !== SOCKET_OPEN) {
      giveUp("the connection to the Realtime API is gone — hanging up.");
      return;
    }
    try {
      sock.send(JSON.stringify(payload));
    } catch (err) {
      giveUp(
        `the connection to the Realtime API failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    connect(spec, onInbound) {
      deliver = (event) => void onInbound(event);
      return new Promise<void>((resolve, reject) => {
        const ws = open(`${REALTIME_URL}?model=${encodeURIComponent(spec.model)}`);
        socket = ws;
        lastHeard = timers.now();
        /** Whether the handshake has had its answer — one of open, error, close or the timeout. */
        let settled = false;

        const overdue = timers.setTimeout(() => {
          if (settled) return;
          settled = true;
          finished = true;
          socket = null;
          ws.close();
          reject(
            new Error(
              `servant summon: the OpenAI Realtime API did not answer within ${Math.round(handshakeTimeoutMs / 1000)}s.`,
            ),
          );
        }, handshakeTimeoutMs);

        const heard = (): void => {
          lastHeard = timers.now();
        };
        const ponged = (): void => {
          answersPings = true;
          heard();
        };

        ws.addEventListener("open", () => {
          timers.clearTimeout(overdue);
          if (settled) return;
          settled = true;
          heard();
          ws.send(JSON.stringify(composeSessionUpdate(spec)));
          beat();
          resolve();
        });
        ws.addEventListener("error", () => {
          timers.clearTimeout(overdue);
          if (settled) {
            giveUp("the connection to the Realtime API failed.");
            return;
          }
          settled = true;
          finished = true;
          reject(new Error("servant summon: could not connect to the OpenAI Realtime API."));
        });
        // A drop after connect must reach the controller, or the mic stays open on a dead socket.
        ws.addEventListener("close", (event) => {
          timers.clearTimeout(overdue);
          stopHeartbeat();
          opts.onDebug?.(`socket closed (code ${event.code}) ${event.reason ?? ""}`.trim());
          if (!settled) {
            settled = true;
            finished = true;
            reject(
              new Error(
                "servant summon: the OpenAI Realtime API closed the connection before the session opened.",
              ),
            );
            return;
          }
          if (finished) return;
          finished = true;
          void onInbound({ type: "closed" });
        });
        // Only ever an answer to one of ours, and the only thing a socket with nothing to say sends.
        ws.addEventListener("pong", ponged);
        ws.addEventListener("message", (message) => {
          heard();
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(message.data));
          } catch {
            return;
          }
          opts.onDebug?.(`recv ${str(asRecord(parsed).type) || "(untyped)"}`);
          const inbound = toInbound(parsed);
          if (inbound) void onInbound(inbound);
        });
      });
    },

    sendAudio(pcm) {
      send({ type: "input_audio_buffer.append", audio: pcm });
    },

    cancelResponse() {
      send({ type: "response.cancel" });
    },

    // `output_audio_buffer.clear` is the other half of this in the API, and it is WebRTC and SIP
    // only — on a WebSocket the queued audio is ours, so the audio port flushes it and this event
    // exists to stop the server believing it said what nobody heard.
    truncateAudio(itemId, playedMs) {
      send({
        type: "conversation.item.truncate",
        item_id: itemId,
        content_index: 0,
        audio_end_ms: playedMs,
      });
    },

    sendToolResult(callId, output) {
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      });
      send({ type: "response.create" });
    },

    // A user turn, and a `response.create` unlike `sendAgentNote` below: nothing has been heard,
    // so no voice-activity detection has started a reply — without asking, a typed line would sit
    // in the conversation unanswered.
    //
    // Which makes this the wrong thing to send *during* a reply, where the second ask is refused:
    // whoever wires a key to it has to decide what typing over a reply means (servant-summon#8).
    sendUserText(text) {
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
      send({ type: "response.create" });
    },

    // No `response.create` here, unlike a tool result or a typed turn: a note is only ever sent
    // just after the user spoke, and voice-activity detection has already started a reply to that.
    // Asking for a second one would collide with it; the note steers the reply instead.
    sendAgentNote(text) {
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text }],
        },
      });
    },

    async close() {
      // Set before anything else: hanging up is not a failure, and nothing below should describe it
      // as one.
      finished = true;
      stopHeartbeat();
      const dying = socket;
      socket = null;
      dying?.close();
      await Promise.resolve();
    },
  };
}
