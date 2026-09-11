// The voice: what is asked of the speech endpoint, what `say` hands back, and the byte arithmetic
// everything downstream measures time with. Offline — the endpoint is a fake `fetch`.

import { describe, expect, test } from "bun:test";
import { tempoArgs } from "../src/core/narrate-audio.ts";
import {
  NARRATION_BYTES_PER_MS,
  NARRATION_SAMPLE_RATE,
  bytesToMs,
  createOpenAiSpeechModel,
  createSaySpeechModel,
  msToBytes,
  pcmFromWav,
} from "../src/core/narrate-voice.ts";

function wav(options: {
  channels?: number;
  rate?: number;
  bits?: number;
  data: Uint8Array;
  padding?: number;
}): Uint8Array {
  const { channels = 1, rate = NARRATION_SAMPLE_RATE, bits = 16, data, padding = 0 } = options;
  const fmt = new Uint8Array(16);
  const view = new DataView(fmt.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, rate, true);
  view.setUint32(8, (rate * channels * bits) / 8, true);
  view.setUint16(12, (channels * bits) / 8, true);
  view.setUint16(14, bits, true);

  const chunks: Uint8Array[] = [tag("fmt "), size(fmt.length), fmt];
  if (padding > 0) chunks.push(tag("FLLR"), size(padding), new Uint8Array(padding));
  chunks.push(tag("data"), size(data.length), data);
  const body = concat(chunks);
  return concat([tag("RIFF"), size(body.length + 4), tag("WAVE"), body]);
}

function tag(text: string): Uint8Array {
  return new Uint8Array(Array.from(text, (character) => character.charCodeAt(0)));
}

function size(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("bytes as time", () => {
  test("a millisecond is forty-eight bytes at this rate", () => {
    expect(NARRATION_BYTES_PER_MS).toBe(48);
    expect(msToBytes(1000)).toBe(48_000);
    expect(bytesToMs(48_000)).toBe(1000);
  });

  test("an offset never lands inside a sample", () => {
    // 1/96 ms is half a sample; rounding into the middle of one byte-swaps everything after it.
    expect(msToBytes(1 / 96) % 2).toBe(0);
    expect(msToBytes(7.3) % 2).toBe(0);
  });
});

describe("the speech endpoint", () => {
  async function drain(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return concat(chunks);
  }

  test("asks for raw pcm, because that is what sox and the timeline both want", async () => {
    let body: Record<string, unknown> = {};
    const model = createOpenAiSpeechModel({
      apiKey: "k",
      fetch: (async (_url: unknown, init: { body?: unknown }) => {
        body = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(new Uint8Array([1, 2, 3, 4]));
      }) as unknown as typeof fetch,
    });
    await drain(model.speak("Some ear-copy."));
    expect(body.response_format).toBe("pcm");
    expect(body.input).toBe("Some ear-copy.");
    expect(body.model).toBe("gpt-4o-mini-tts");
  });

  test("a failure says what the endpoint said, rather than going quiet", async () => {
    const model = createOpenAiSpeechModel({
      apiKey: "k",
      fetch: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
    });
    expect(drain(model.speak("x"))).rejects.toThrow(/429/);
  });

  test("a changed delivery style changes the engine, so the cache misses", () => {
    const plain = createOpenAiSpeechModel({ apiKey: "k" });
    const tuned = createOpenAiSpeechModel({ apiKey: "k", style: "read it like a pirate" });
    expect(tuned.engine).not.toBe(plain.engine);
    expect(plain.engine).toBe("gpt-4o-mini-tts");
  });
});

describe("`say` as the offline engine", () => {
  test("the data chunk is found by walking, not by skipping forty-four bytes", () => {
    const data = new Uint8Array([9, 8, 7, 6]);
    // `say` writes an FLLR padding chunk between `fmt ` and `data`; the fixed offset lands in it.
    expect(pcmFromWav(wav({ data, padding: 4000 }))).toEqual(data);
  });

  test("a format the timeline could not measure is refused rather than played", () => {
    expect(() => pcmFromWav(wav({ data: new Uint8Array(4), rate: 44_100 }))).toThrow(/44100/);
    expect(() => pcmFromWav(wav({ data: new Uint8Array(4), channels: 2 }))).toThrow(/PCM/);
  });

  test("something that is not a WAVE at all is refused clearly", () => {
    expect(() => pcmFromWav(new Uint8Array(64))).toThrow(/WAVE/);
  });

  test("it declares itself as its own engine, so its audio is never confused for the API's", () => {
    expect(createSaySpeechModel().engine).toBe("say");
  });
});

describe("tempo", () => {
  test("is a sox effect", () => {
    expect(tempoArgs(1.5)).toEqual(["tempo", "-s", "1.50"]);
  });

  test("is left out entirely at normal speed, where there is nothing to stretch", () => {
    expect(tempoArgs(1)).toEqual([]);
  });
});
