import { describe, expect, test } from "bun:test";
import { composeSessionUpdate, toInbound } from "../src/core/summons-realtime.ts";
import { DEFAULT_SUMMONS_MODEL, DEFAULT_SUMMONS_VOICE } from "../src/core/summons.ts";

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
