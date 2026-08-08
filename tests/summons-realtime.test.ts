import { describe, expect, test } from "bun:test";
import { toInbound } from "../src/core/summons-realtime.ts";

describe("Realtime server events the controller acts on", () => {
  test("model speech becomes playable audio", () => {
    expect(toInbound({ type: "response.output_audio.delta", delta: "c3BlZWNo" })).toEqual({
      type: "audio",
      pcm: "c3BlZWNo",
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

  test("events the controller has no opinion about are ignored", () => {
    expect(toInbound({ type: "session.updated" })).toBeNull();
    expect(toInbound({ type: "response.done" })).toBeNull();
    expect(toInbound("not an event")).toBeNull();
  });
});
