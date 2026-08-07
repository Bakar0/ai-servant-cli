import type { RealtimeInbound, RealtimeSessionSpec, RealtimeTransport } from "./talk.ts";

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
      return { type: "audio", pcm: str(e.delta) };
    case "input_audio_buffer.speech_started":
      return { type: "user_speaking" };
    case "response.function_call_arguments.done":
      return {
        type: "tool_call",
        callId: str(e.call_id),
        name: str(e.name),
        args: str(e.arguments),
      };
    case "response.output_audio_transcript.done":
      return { type: "assistant_transcript", text: str(e.transcript) };
    case "error":
      return { type: "error", message: str(asRecord(e.error).message) || "Realtime error" };
    default:
      return null;
  }
}

function sessionUpdate(spec: RealtimeSessionSpec): string {
  return JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      model: spec.model,
      instructions: spec.instructions,
      audio: {
        // Server-side voice-activity detection is what makes the session hands-free: the model
        // decides when a turn ends, so no key is ever held or pressed to talk.
        input: { turn_detection: { type: "server_vad" } },
        output: { voice: spec.voice },
      },
      tools: spec.tools.map((tool) => ({ type: "function", ...tool })),
      tool_choice: "auto",
    },
  });
}

export function createOpenAiRealtimeTransport(apiKey: string): RealtimeTransport {
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
          ws.send(sessionUpdate(spec));
          resolve();
        });
        ws.addEventListener("error", () =>
          reject(new Error("servant talk: could not connect to the OpenAI Realtime API.")),
        );
        // A drop after connect must reach the controller, or the mic stays open on a dead socket.
        ws.addEventListener("close", () => void onInbound({ type: "closed" }));
        ws.addEventListener("message", (message) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(message.data));
          } catch {
            return;
          }
          const inbound = toInbound(parsed);
          if (inbound) void onInbound(inbound);
        });
      });
    },

    sendAudio(pcm) {
      send({ type: "input_audio_buffer.append", audio: pcm });
    },

    sendToolResult(callId, output) {
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      });
      send({ type: "response.create" });
    },

    async close() {
      socket?.close();
      socket = null;
      await Promise.resolve();
    },
  };
}
