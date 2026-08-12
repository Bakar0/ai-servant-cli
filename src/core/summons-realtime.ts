import type { RealtimeInbound, RealtimeSessionSpec, RealtimeTransport } from "./summons.ts";

// The OpenAI Realtime transport: one WebSocket carrying native speech-to-speech in both directions,
// so there is no STT/TTS pipeline in the path (workspace ADR 0009). This is the seam's outside —
// it translates wire events into the handful the controller reasons about and nothing more.

const REALTIME_URL = "wss://api.openai.com/v1/realtime";

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

export interface RealtimeTransportOptions {
  onDebug?: ((message: string) => void) | undefined;
}

export function createOpenAiRealtimeTransport(
  apiKey: string,
  opts: RealtimeTransportOptions = {},
): RealtimeTransport {
  let socket: WebSocket | null = null;

  function send(payload: unknown): void {
    socket?.send(JSON.stringify(payload));
  }

  return {
    connect(spec, onInbound) {
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(spec.model)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        socket = ws;

        ws.addEventListener("open", () => {
          ws.send(JSON.stringify(composeSessionUpdate(spec)));
          resolve();
        });
        ws.addEventListener("error", () =>
          reject(new Error("servant summon: could not connect to the OpenAI Realtime API.")),
        );
        // A drop after connect must reach the controller, or the mic stays open on a dead socket.
        ws.addEventListener("close", (event) => {
          opts.onDebug?.(`socket closed (code ${event.code}) ${event.reason}`.trim());
          void onInbound({ type: "closed" });
        });
        ws.addEventListener("message", (message) => {
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

    // No `response.create` here, unlike a tool result: a note is only ever sent just after the user
    // spoke, and voice-activity detection has already started a reply to that. Asking for a second
    // one would collide with it; the note lands in the conversation and steers the reply instead.
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
      socket?.close();
      socket = null;
      await Promise.resolve();
    },
  };
}
