// The Player, with a fake voice, a fake `sox` and a clock the test moves itself. Nothing here
// makes a sound or a request, which is what lets the parts that are actually decisions — when a
// sentence is synthesized, what the cache saves, what a Transport key does to the run in flight,
// and what happens when a Segment cannot be spoken — be asserted at all.

import { describe, expect, test } from "bun:test";
import type { NarrationCache } from "../src/core/narrate-cache.ts";
import type { NarrationSpeaker, PlaybackRun } from "../src/core/narrate-audio.ts";
import {
  TEMPO_MAX,
  TEMPO_MIN,
  TEMPO_STEP,
  createNarrationPlayer,
} from "../src/core/narrate-player.ts";
import type { NarrationPlayer } from "../src/core/narrate-player.ts";
import type { NarrationEvent, Segment } from "../src/core/narrate.ts";
import { type SpeechModel, msToBytes } from "../src/core/narrate-voice.ts";

/** One second of "audio" per sentence, so every assertion below reads in seconds. */
const SECOND = msToBytes(1000);

function pcm(fill: number, length = SECOND): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** A clock the test advances. `wait` yields a macrotask, so everything else still gets to run. */
function fakeClock() {
  let ms = 0;
  return {
    now: () => ms,
    // Time moves when the wait *resolves*, not when it is asked for — otherwise a pump that is
    // about to wait advances the clock inside a synchronous call the test made, and every position
    // assertion is off by one tick.
    wait: (by: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          ms += by;
          resolve();
        }, 0);
      }),
  };
}

function fakeSpeech(overrides: Partial<SpeechModel> = {}) {
  const spoken: string[] = [];
  const model: SpeechModel & { spoken: string[] } = {
    spoken,
    engine: "fake-tts",
    voice: "test",
    async *speak(text: string) {
      spoken.push(text);
      // Two chunks, because a sentence arriving in halves is the ordinary case and the Player has
      // to be able to start playing the first half.
      yield pcm(spoken.length, SECOND / 2);
      yield pcm(spoken.length, SECOND / 2);
    },
    ...overrides,
  };
  return model;
}

interface FakeRun extends PlaybackRun {
  written: Uint8Array[];
  killed: boolean;
  finished: boolean;
}

function fakeSpeaker() {
  const runs: FakeRun[] = [];
  const tempos: number[] = [];
  const speaker: NarrationSpeaker = {
    open(tempo) {
      tempos.push(tempo);
      const run: FakeRun = {
        written: [],
        killed: false,
        finished: false,
        write(chunk) {
          run.written.push(chunk);
        },
        async finish() {
          run.finished = true;
        },
        kill() {
          run.killed = true;
        },
        exited: Promise.resolve(0),
      };
      runs.push(run);
      return run;
    },
  };
  return { speaker, runs, tempos, bytesOf: (run: FakeRun) => concat(run.written) };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function fakeCache() {
  const stored = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const cache: NarrationCache = {
    path: (at, sentence, digest) => `${at}-${sentence}-${digest}`,
    async read(at, sentence, digest) {
      const key = `${at}-${sentence}-${digest}`;
      reads.push(key);
      return stored.get(key) ?? null;
    },
    async write(at, sentence, digest, bytes) {
      stored.set(`${at}-${sentence}-${digest}`, bytes);
    },
  };
  return { cache, stored, reads };
}

function segment(index: number, text: string, extra: Partial<Segment> = {}): Segment {
  return { index, kind: "prose", text, cues: [], source: text, ...extra };
}

/** A Turn of `n` one-sentence Segments, all arriving at once. */
function scripted(events: NarrationEvent[]): AsyncIterable<NarrationEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        await Promise.resolve();
        yield event;
      }
    },
  };
}

function twoSegments(): NarrationEvent[] {
  return [
    { type: "sentence", segment: 0, text: "First." },
    { type: "segment", segment: segment(0, "First.") },
    { type: "sentence", segment: 1, text: "Second." },
    { type: "segment", segment: segment(1, "Second.") },
  ];
}

/** Let the Player get on with it: advance the clock until it settles or the budget runs out. */
async function settle(player: NarrationPlayer, clock: ReturnType<typeof fakeClock>, ticks = 400) {
  for (let i = 0; i < ticks; i++) {
    if (player.state().finished) break;
    await clock.wait(20);
  }
}

describe("synthesis", () => {
  test("a sentence is synthesized before its Segment closes", async () => {
    const clock = fakeClock();
    const speech = fakeSpeech();
    const player = createNarrationPlayer({
      events: scripted([
        { type: "sentence", segment: 0, text: "First." },
        { type: "sentence", segment: 0, text: "Second." },
        { type: "segment", segment: segment(0, "First. Second.") },
      ]),
      speech,
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    await settle(player, clock);
    await player.stop();
    expect(speech.spoken).toEqual(["First.", "Second."]);
  });

  test("a Segment's Ear-copy and cues reach the screen", async () => {
    const clock = fakeClock();
    const player = createNarrationPlayer({
      events: scripted([
        { type: "sentence", segment: 0, text: "There's a table here." },
        {
          type: "segment",
          segment: segment(0, "There's a table here.", {
            kind: "description",
            cues: [{ node: "table", fate: "describe", say: "a table", source: "|a|b|" }],
          }),
        },
      ]),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    await settle(player, clock);
    await player.stop();
    expect(player.state().segments[0]).toMatchObject({
      kind: "description",
      text: "There's a table here.",
      ready: true,
    });
    expect(player.state().segments[0]?.cues[0]?.say).toBe("a table");
  });
});

describe("the cache", () => {
  test("what was synthesized is kept", async () => {
    const clock = fakeClock();
    const { cache, stored } = fakeCache();
    const player = createNarrationPlayer({
      events: scripted(twoSegments()),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      cache,
      ...clock,
    });
    await settle(player, clock);
    await player.stop();
    expect(stored.size).toBe(2);
    expect([...stored.values()][0]?.length).toBe(SECOND);
  });

  test("a second listen makes no synthesis calls at all", async () => {
    const first = fakeClock();
    const { cache } = fakeCache();
    const one = createNarrationPlayer({
      events: scripted(twoSegments()),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      cache,
      ...first,
    });
    await settle(one, first);
    await one.stop();

    const second = fakeClock();
    const speech = fakeSpeech();
    const two = createNarrationPlayer({
      events: scripted(twoSegments()),
      speech,
      speaker: fakeSpeaker().speaker,
      cache,
      ...second,
    });
    await settle(two, second);
    await two.stop();
    expect(speech.spoken).toEqual([]);
  });

  test("a tuned rewrite is a miss, not a stale voice", async () => {
    const clock = fakeClock();
    const { cache } = fakeCache();
    const before = createNarrationPlayer({
      events: scripted([
        { type: "sentence", segment: 0, text: "Old words." },
        { type: "segment", segment: segment(0, "Old words.") },
      ]),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      cache,
      ...clock,
    });
    await settle(before, clock);
    await before.stop();

    const next = fakeClock();
    const speech = fakeSpeech();
    const after = createNarrationPlayer({
      events: scripted([
        { type: "sentence", segment: 0, text: "New words." },
        { type: "segment", segment: segment(0, "New words.") },
      ]),
      speech,
      speaker: fakeSpeaker().speaker,
      cache,
      ...next,
    });
    await settle(after, next);
    await after.stop();
    expect(speech.spoken).toEqual(["New words."]);
  });
});

describe("playback", () => {
  test("the Segments are played in order, end to end", async () => {
    const clock = fakeClock();
    const audio = fakeSpeaker();
    const player = createNarrationPlayer({
      events: scripted(twoSegments()),
      speech: fakeSpeech(),
      speaker: audio.speaker,
      ...clock,
    });
    await settle(player, clock);
    const heard = concat(audio.runs.flatMap((run) => run.written));
    expect(heard.length).toBe(2 * SECOND);
    expect(heard[0]).toBe(1);
    expect(heard[SECOND + 10]).toBe(2);
    await player.stop();
  });

  test("it finishes on its own once there is nothing left", async () => {
    const clock = fakeClock();
    const player = createNarrationPlayer({
      events: scripted(twoSegments()),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    await settle(player, clock);
    expect(player.state().finished).toBe(true);
    expect(player.state().playing).toBe(false);
    // The Player stays up: `done` is the answer to "has it been quit", not "has it stopped talking".
    await player.stop();
    await player.done;
  });
});

describe("the Transport", () => {
  async function playing() {
    const clock = fakeClock();
    const audio = fakeSpeaker();
    const player = createNarrationPlayer({
      events: scripted([
        { type: "sentence", segment: 0, text: "One." },
        { type: "sentence", segment: 0, text: "Two." },
        { type: "sentence", segment: 0, text: "Three." },
        { type: "segment", segment: segment(0, "One. Two. Three.") },
      ]),
      speech: fakeSpeech(),
      speaker: audio.speaker,
      ...clock,
    });
    // Far enough in that there is something to seek backwards from, and not so far that it ended.
    for (let i = 0; i < 12 && !player.state().finished; i++) await clock.wait(100);
    return { player, audio, clock };
  }

  test("space pauses where it is and leaves the position alone", async () => {
    const { player, audio } = await playing();
    const at = player.state().positionMs;
    player.toggle();
    expect(player.state().playing).toBe(false);
    expect(player.state().positionMs).toBeCloseTo(at, 0);
    expect(audio.runs.some((run) => run.killed)).toBe(true);
    await player.stop();
  });

  test("space again picks up from the same place", async () => {
    const { player, clock } = await playing();
    player.toggle();
    const at = player.state().positionMs;
    await clock.wait(500);
    expect(player.state().positionMs).toBe(at);
    player.toggle();
    expect(player.state().playing).toBe(true);
    await player.stop();
  });

  test("back five seconds is five seconds, and clamps at the start", async () => {
    const { player } = await playing();
    player.back();
    expect(player.state().positionMs).toBe(0);
    await player.stop();
  });

  test("back five seconds from further in moves exactly five", async () => {
    const clock = fakeClock();
    const player = createNarrationPlayer({
      events: scripted(
        Array.from({ length: 20 }, (_, i) => [
          { type: "sentence" as const, segment: 0, text: `S${i}.` },
        ]).flat(),
      ),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    for (let i = 0; i < 12; i++) await clock.wait(1000);
    const before = player.state().positionMs;
    player.back();
    expect(before - player.state().positionMs).toBeCloseTo(5000, 0);
    await player.stop();
  });

  test("a seek opens a new run at the new position", async () => {
    const { player, audio } = await playing();
    const runsBefore = audio.runs.length;
    player.back();
    expect(audio.runs.length).toBeGreaterThan(runsBefore);
    expect(concat(audio.runs[audio.runs.length - 1]?.written ?? [])[0]).toBe(1);
    await player.stop();
  });

  test("j goes to the next Segment, and stops at the last one", async () => {
    const clock = fakeClock();
    const player = createNarrationPlayer({
      events: scripted(twoSegments()),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    for (let i = 0; i < 4; i++) await clock.wait(50);
    player.nextSegment();
    expect(player.state().position.segment).toBe(1);
    player.nextSegment();
    expect(player.state().position.segment).toBe(1);
    await player.stop();
  });

  test("tempo is a playback effect, so a change re-opens the run", async () => {
    const { player, audio } = await playing();
    player.faster();
    expect(player.state().tempo).toBeCloseTo(1 + TEMPO_STEP, 5);
    expect(audio.tempos[audio.tempos.length - 1]).toBeCloseTo(1 + TEMPO_STEP, 5);
    await player.stop();
  });

  test("tempo stops at both ends rather than becoming unlistenable", async () => {
    const { player } = await playing();
    for (let i = 0; i < 40; i++) player.faster();
    expect(player.state().tempo).toBe(TEMPO_MAX);
    for (let i = 0; i < 80; i++) player.slower();
    expect(player.state().tempo).toBe(TEMPO_MIN);
    await player.stop();
  });

  test("tempo scales how fast the position moves", async () => {
    const clock = fakeClock();
    const player = createNarrationPlayer({
      events: scripted(
        Array.from({ length: 30 }, (_, i) => ({
          type: "sentence" as const,
          segment: 0,
          text: `S${i}.`,
        })),
      ),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    for (let i = 0; i < 5; i++) await clock.wait(200);
    player.faster();
    const before = player.state().positionMs;
    const wall = clock.now();
    await clock.wait(1000);
    const elapsed = clock.now() - wall;
    expect(player.state().positionMs - before).toBeCloseTo(elapsed * (1 + TEMPO_STEP), 0);
    await player.stop();
  });
});

describe("when a Segment cannot be spoken", () => {
  const leaking: NarrationEvent[] = [
    { type: "sentence", segment: 0, text: "Fine." },
    { type: "segment", segment: segment(0, "Fine.") },
    { type: "leak", segment: 1, leaks: [{ kind: "path", text: "src/core/narrate.ts" }] },
    { type: "sentence", segment: 1, text: "There's a code block here." },
    { type: "segment", segment: segment(1, "There's a code block here.", { kind: "description" }) },
  ];

  test("the Narration stops at that Segment, not the instant it is noticed", async () => {
    const clock = fakeClock();
    const player = createNarrationPlayer({
      events: scripted(leaking),
      speech: fakeSpeech(),
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    for (let i = 0; i < 200 && !player.state().halted; i++) await clock.wait(20);
    expect(player.state().halted).toContain("segment 1");
    expect(player.state().halted).toContain("path");
    expect(player.state().position.segment).toBe(1);
    expect(player.state().positionMs).toBeCloseTo(1000, 0);
    await player.stop();
  });

  test("r goes past it, and it speaks its cue", async () => {
    const clock = fakeClock();
    const audio = fakeSpeaker();
    const player = createNarrationPlayer({
      events: scripted(leaking),
      speech: fakeSpeech(),
      speaker: audio.speaker,
      ...clock,
    });
    for (let i = 0; i < 200 && !player.state().halted; i++) await clock.wait(20);
    player.retry();
    await settle(player, clock);
    expect(player.state().halted).toBeNull();
    expect(concat(audio.runs.flatMap((run) => run.written)).length).toBeGreaterThan(SECOND);
    await player.stop();
  });

  test("a synthesis failure pauses and says which Segment, rather than going quiet", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const speech = fakeSpeech({
      async *speak(text: string) {
        attempts += 1;
        if (text === "Second." && attempts < 3) throw new Error("500 from the endpoint");
        yield pcm(9);
      },
    });
    const player = createNarrationPlayer({
      events: scripted(twoSegments()),
      speech,
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    for (let i = 0; i < 200 && !player.state().halted; i++) await clock.wait(20);
    expect(player.state().halted).toContain("segment 1");
    expect(player.state().halted).toContain("500");
    await player.stop();
  });

  test("a retried sentence replaces what failed, in its own place", async () => {
    const clock = fakeClock();
    const audio = fakeSpeaker();
    let attempts = 0;
    // "Second." streams half a sentence and then throws; the retry produces the whole thing.
    const speech = fakeSpeech({
      async *speak(text: string) {
        if (text !== "Second.") {
          yield pcm(1);
          return;
        }
        attempts += 1;
        if (attempts === 1) {
          yield pcm(7, SECOND / 2);
          throw new Error("500 from the endpoint");
        }
        yield pcm(2);
      },
    });
    const player = createNarrationPlayer({
      events: scripted([
        ...twoSegments(),
        { type: "sentence", segment: 1, text: "Third." },
        { type: "segment", segment: segment(1, "Second. Third.") },
      ]),
      speech,
      speaker: audio.speaker,
      ...clock,
    });
    for (let i = 0; i < 200 && !player.state().halted; i++) await clock.wait(20);
    const runsAtHalt = audio.runs.length;
    player.retry();
    await settle(player, clock);

    // What the retry actually plays: everything opened after `r`, which restarts at the head of the
    // failed Segment. The half-sentence is gone from it, not sitting in place with the retried
    // sentence appended after the sentence that follows it.
    const afterRetry = concat(audio.runs.slice(runsAtHalt).flatMap((run) => run.written));
    expect(afterRetry.length).toBe(2 * SECOND);
    expect(afterRetry[10]).toBe(2);
    expect(afterRetry[SECOND + 10]).toBe(1);
    expect(afterRetry.includes(7)).toBe(false);
    await player.stop();
  });

  test("r retries the synthesis that failed", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const speech = fakeSpeech({
      async *speak(text: string) {
        attempts += 1;
        if (text === "Second." && attempts === 2) throw new Error("500 from the endpoint");
        yield pcm(9);
      },
    });
    const player = createNarrationPlayer({
      events: scripted(twoSegments()),
      speech,
      speaker: fakeSpeaker().speaker,
      ...clock,
    });
    for (let i = 0; i < 200 && !player.state().halted; i++) await clock.wait(20);
    player.retry();
    await settle(player, clock);
    expect(attempts).toBe(3);
    expect(player.state().halted).toBeNull();
    await player.stop();
  });
});
