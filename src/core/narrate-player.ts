import { type NarrationCache, earCopyDigest } from "./narrate-cache.ts";
import type { NarrationSpeaker, PlaybackRun } from "./narrate-audio.ts";
import {
  type Position,
  SEEK_STEP_MS,
  type Timeline,
  clamp,
  createTimeline,
} from "./narrate-timeline.ts";
import type { BlockKind, Cue, NarrationEvent } from "./narrate.ts";
import { type SpeechModel, bytesToMs, msToBytes } from "./narrate-voice.ts";

// The Player: Ear-copy in one end, a voice with working controls out the other.
//
// Three clocks have to agree and only one of them is real. Synthesis runs ahead as fast as the two
// APIs allow; `sox` plays whatever it has been given; and the position on screen is arithmetic —
// where the run started, plus how long ago that was, times the tempo. The arithmetic is what the
// Transport moves, and killing `sox` and opening another one is how the arithmetic is made true.
// Steering a long-lived process instead would mean asking it to skip seconds it has already
// buffered, which is the difference between ← feeling immediate and ← feeling like a request.

/** Tempo steps, and the ends of the range. Below 0.7 it drags; above 2.2 speech stops being speech. */
export const TEMPO_STEP = 0.1;
export const TEMPO_MIN = 0.7;
export const TEMPO_MAX = 2.2;

/**
 * How much audio to have in hand before opening a `sox`.
 *
 * A `sox` started before there is anything to play opens the output device and starves it, and the
 * device does not recover cleanly: the first second comes out as a growl and then clears up. Learnt
 * on the Summons speaker (servant-summon#2); the same device behaves the same way here.
 *
 * Half what the Summons holds back, because this is the front of the latency budget and every
 * millisecond of it is time before the first word. It is still a real cushion: synthesis runs at
 * roughly four times real time, so by the time these 300 ms have played there is over a second
 * behind them. Hand-verified — nothing but an ear can tell whether a device was starved.
 */
export const PRIME_BYTES = msToBytes(300);

/** How often the pump looks at the world while a run is playing. Well under the 200 ms gap budget. */
const TICK_MS = 40;

/**
 * The pause after a Segment — the beat #1 left to this ticket to size, since the text half owns no
 * timing and a heading arrives carrying nothing but its kind.
 *
 * Every Segment gets one, because paragraphs on a screen are separated by white space and read out
 * as one continuous stream they run together into exactly the wall of words the listener was trying
 * to escape. A heading gets a shorter one: it has just announced a section and the section should
 * follow it, not wait.
 *
 * Silence rather than a timer, so it is part of the timeline like everything else — it seeks, it
 * rewinds, and ±5s counts it. A pause the Transport could not move through would be a hole.
 */
export const PAUSE_AFTER_SEGMENT_MS = 480;
export const PAUSE_AFTER_BEAT_MS = 300;

/** One Segment, as the screen and the Transport see it. */
export interface PlayerSegment {
  index: number;
  kind: BlockKind;
  /** The Ear-copy, growing sentence by sentence. This is what the screen shows. */
  text: string;
  cues: readonly Cue[];
  /** Where this Segment starts on the concatenated timeline. What the screen shows beside it. */
  startsAtMs: number;
  /** Set when this Segment is something the listener has to be shown before it is spoken. */
  notice: string | null;
  /** True once the Segment has closed and every sentence in it has audio. */
  ready: boolean;
}

export interface PlayerState {
  segments: readonly PlayerSegment[];
  position: Position;
  positionMs: number;
  totalMs: number;
  playing: boolean;
  tempo: number;
  /** Why playback stopped where it did. Null while it is simply playing or simply paused. */
  halted: string | null;
  /** The whole Turn has been rewritten and synthesized. Nothing more is coming. */
  synthesized: boolean;
  /** Played to the end of a synthesized Turn. */
  finished: boolean;
}

export interface NarrationPlayerOptions {
  /** The text half, already running. Sentences to synthesize, Segments to seek over. */
  events: AsyncIterable<NarrationEvent>;
  speech: SpeechModel;
  speaker: NarrationSpeaker;
  /** Absent means synthesize everything every time — which is what a `--no-cache` run wants. */
  cache?: NarrationCache | undefined;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /**
   * How often to redraw while a Segment is being spoken. Off unless a screen asked for it.
   *
   * The position is arithmetic over the wall clock, so it is always right when it is *asked* for —
   * but it only reaches a screen when something publishes it, and everything that publishes is an
   * event: a sentence arriving, a key, a halt. Synthesis runs about four times faster than speech,
   * so those events all happen in the first quarter of a Narration and then stop. Without a clock
   * of its own the live position moves in lurches while the Turn is being written and then sits
   * still for the rest of it, several Segments behind the voice.
   */
  redrawMs?: number | undefined;
  onState?: (state: PlayerState) => void;
  onDebug?: (message: string) => void;
}

export interface NarrationPlayer {
  state(): PlayerState;
  /** Space. */
  toggle(): void;
  /** ← and →: five seconds of the concatenated Segment timeline, boundaries and all. */
  back(): void;
  forward(): void;
  /** j and k. */
  nextSegment(): void;
  prevSegment(): void;
  /** [ and ]. */
  slower(): void;
  faster(): void;
  /** r: acknowledge what stopped the Narration, retrying the synthesis if that is what failed. */
  retry(): void;
  /** Something outside the Player went wrong — the device, say. Pause and show it, never silence. */
  note(message: string): void;
  stop(): Promise<void>;
  /** Resolves when the Narration has been heard to the end, or stopped. */
  done: Promise<void>;
}

interface PendingSentence {
  segment: number;
  sentence: number;
  text: string;
}

export function createNarrationPlayer(options: NarrationPlayerOptions): NarrationPlayer {
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? ((ms: number) => Bun.sleep(ms));
  const timeline: Timeline = createTimeline();

  const segments: PlayerSegment[] = [];
  /** Segments whose `segment` event has arrived — nothing more will be added to their Ear-copy. */
  const closed = new Set<number>();
  /** Sentences whose synthesis threw. Held so `r` can put them back rather than losing them. */
  const failed: PendingSentence[] = [];
  /** Sentences owed audio: queued, in flight, or held after a failure. Keyed `segment:sentence`. */
  const owed = new Set<string>();
  /** Segments whose closing pause has been added, so it is added once and not once per sentence. */
  const rested = new Set<number>();
  /**
   * Per Segment, per sentence, that sentence's PCM chunks. `audio[segment][sentence]`.
   *
   * A slot per sentence rather than one flat list per Segment, because `r` has to be able to replace
   * a sentence rather than append one. Flat, a synthesis that threw halfway left its truncated audio
   * in place and the retry landed at the end of the Segment — so the listener heard the fragment
   * where it belonged and the whole sentence again after everything that follows it.
   */
  const audio: Uint8Array[][][] = [];
  /** Segments whose notice the listener has already seen and chosen to go past. */
  const acknowledged = new Set<number>();

  let tempo = 1;
  let playing = false;
  /**
   * Whether a `sox` is actually running. Not the same as `playing`, and conflating them costs the
   * whole latency budget: `playing` is the listener's intent, which is true from the moment the
   * Player opens, while there is nothing to hear until the first Segment has been synthesized. A
   * position that advanced on wall-clock through that wait would consume audio nobody heard —
   * pinning itself to the end of what exists, so the pump could never see the cushion it needs to
   * open the device with, and the first word landing at 3.4s instead of 2.1s.
   */
  let sounding = false;
  let halted: string | null = null;
  let synthesized = false;
  let finished = false;
  let stopped = false;
  const isStopped = (): boolean => stopped;

  /** Where the run started and when, in wall-clock. Everything about position comes from these two. */
  let anchorBytes = 0;
  let anchorAt = now();

  let run: PlaybackRun | null = null;
  /** Bumped by every Transport action, which is how the pump in flight learns it is the old one. */
  let generation = 0;

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // --- position -------------------------------------------------------------------------------

  const availableBytes = (): number => timeline.totalBytes();

  const positionBytes = (): number => {
    const ceiling = ceilingBytes();
    if (!playing || !sounding) return clamp(anchorBytes, 0, ceiling);
    const heard = msToBytes((now() - anchorAt) * tempo);
    return clamp(anchorBytes + heard, 0, ceiling);
  };

  /** Freeze where we are and start counting again from here. Every Transport action does this. */
  const reanchor = (bytes: number = positionBytes()): void => {
    anchorBytes = clamp(bytes, 0, availableBytes());
    anchorAt = now();
  };

  /**
   * The first Segment ahead of us the listener has not been shown yet, as an absolute offset.
   *
   * The Narration stops *there* rather than the instant the problem is noticed, because a leak or a
   * failed synthesis is usually found several Segments ahead of the voice. Stopping immediately
   * would cut off a paragraph that is perfectly fine, and stopping silently would speak a Cue where
   * a description should have been with nothing to say so. "Do not surprise the ears."
   *
   * Measured from the anchor rather than from the live position, which is what makes it a barrier
   * at all. Asked "is there a bad Segment ahead of where I am *now*", it answers no the instant the
   * position steps over one — so the position steps over one. Asked from the anchor, which only
   * moves when a run starts or a key is pressed, it stays put and the position clamps against it.
   */
  const barrier = (): { bytes: number; segment: number } | null => {
    for (const segment of segments) {
      if (!segment?.notice || acknowledged.has(segment.index)) continue;
      const starts = timeline.absolute({ segment: segment.index, offset: 0 });
      if (starts >= anchorBytes) return { bytes: starts, segment: segment.index };
    }
    return null;
  };

  /** How far the position is allowed to go: what has been synthesized, or the next barrier. */
  const ceilingBytes = (): number =>
    Math.min(availableBytes(), barrier()?.bytes ?? Number.POSITIVE_INFINITY);

  const snapshot = (): PlayerState => {
    const bytes = positionBytes();
    return {
      segments: [...segments].filter(Boolean).map((segment) => ({
        ...segment,
        startsAtMs: timeline.msAt({ segment: segment.index, offset: 0 }),
      })),
      position: timeline.at(bytes),
      positionMs: bytesToMs(bytes),
      totalMs: timeline.totalMs(),
      playing,
      tempo,
      halted,
      synthesized,
      finished,
    };
  };

  const publish = (): void => options.onState?.(snapshot());

  // --- the pump -------------------------------------------------------------------------------

  /** Wake the pump early. Called whenever audio lands, so a stall ends the moment it can. */
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    wake?.();
    wake = null;
  };
  const tick = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
      void wait(TICK_MS).then(() => {
        if (wake === resolve) wake = null;
        resolve();
        return undefined;
      });
    });

  const restart = (): void => {
    generation += 1;
    sounding = false;
    run?.kill();
    run = null;
    if (playing) void pump(generation);
  };

  /** Whether this pump is still the current one and still has a reason to be running. */
  const running = (mine: number): boolean => mine === generation && playing && !stopped;

  async function pump(mine: number): Promise<void> {
    while (running(mine)) {
      const start = positionBytes();
      const stop = barrier();

      if (stop && start >= stop.bytes) return haltAt(stop.segment);

      const ceiling = ceilingBytes();
      // Nothing to play yet. If nothing more is coming either, the Narration is over.
      if (start >= ceiling) {
        if (synthesized && !stop) return finish();
        await tick();
        continue;
      }
      // Enough behind the device before it opens, or there is no more to wait for.
      if (ceiling - start < PRIME_BYTES && !synthesized && !stop) {
        await tick();
        continue;
      }

      reanchor(start);
      const current = options.speaker.open(tempo);
      run = current;
      sounding = true;
      let cursor = start;

      while (running(mine)) {
        const limit = ceilingBytes();
        if (cursor < limit) {
          current.write(sliceAudio(cursor, limit));
          cursor = limit;
        }
        const heard = positionBytes();
        if (cursor >= limit && heard >= limit) {
          // The voice has caught up with what exists. Either that is the end, or the pipeline fell
          // behind — and in both cases this run is finished with. A new one opens at the true
          // position once there is something to open it for.
          break;
        }
        await tick();
      }

      if (!running(mine)) {
        current.kill();
        // Only if this run is still the current one. A Transport key opens the next run before this
        // pump wakes up to notice it has been retired, and clearing the flag unconditionally would
        // freeze the position under a `sox` that is already speaking.
        if (run === current) {
          run = null;
          sounding = false;
        }
        return;
      }

      // Drained rather than killed, so everything handed to it has been heard: the position is
      // exactly what was written, and not the wall clock's guess at it.
      await current.finish();
      if (run === current) {
        run = null;
        sounding = false;
      }
      reanchor(cursor);

      const next = barrier();
      if (next && positionBytes() >= next.bytes) return haltAt(next.segment);
      if (synthesized && !next && positionBytes() >= availableBytes()) return finish();
      options.onDebug?.("playback ran out of synthesized audio and re-opened at the same position");
    }
  }

  function haltAt(segment: number): void {
    playing = false;
    sounding = false;
    reanchor(timeline.absolute({ segment, offset: 0 }));
    halted = segments[segment]?.notice ?? `segment ${segment} cannot be spoken`;
    run?.kill();
    run = null;
    publish();
  }

  /**
   * The end of the Narration, which is not the end of the Player: the Ear-copy stays on screen and
   * the Transport still works, so the last paragraph can be heard again without narrating the Turn
   * a second time. `done` waits for `stop`, not for this.
   */
  function finish(): void {
    playing = false;
    sounding = false;
    finished = true;
    reanchor(availableBytes());
    publish();
  }

  /** The concatenated timeline, cut. Segment boundaries are byte boundaries and nothing else. */
  function sliceAudio(from: number, to: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, to - from));
    let written = 0;
    let base = 0;
    for (let index = 0; index < audio.length; index++) {
      let inSegment = 0;
      const playable = timeline.lengthOf(index);
      for (const chunks of audio[index] ?? []) {
        if (inSegment >= playable) break;
        for (const chunk of chunks ?? []) {
          inSegment += chunk.length;
          const chunkStart = base;
          base += chunk.length;
          if (base <= from) continue;
          const take = chunk.subarray(
            Math.max(0, from - chunkStart),
            Math.max(0, Math.min(chunk.length, to - chunkStart)),
          );
          if (take.length === 0) continue;
          out.set(take, written);
          written += take.length;
          if (written >= out.length) return out;
        }
      }
    }
    return written === out.length ? out : out.subarray(0, written);
  }

  // --- synthesis ------------------------------------------------------------------------------

  const queue: PendingSentence[] = [];
  let queued: (() => void) | null = null;
  let eventsDone = false;

  const enqueue = (item: PendingSentence): void => {
    queue.push(item);
    owed.add(`${item.segment}:${item.sentence}`);
    // Synchronously, before the worker gets a turn. `r` re-queues a failed sentence and then
    // restarts the pump in the same tick; a `synthesized` still reading true for that one tick is
    // enough for the pump to decide the Narration is over and stop for good.
    synthesized = false;
    finished = false;
    queued?.();
    queued = null;
  };

  const ensureSegment = (index: number, patch: Partial<PlayerSegment> = {}): PlayerSegment => {
    const existing = segments[index];
    if (existing) {
      Object.assign(existing, patch);
      return existing;
    }
    const created: PlayerSegment = {
      index,
      kind: "prose",
      text: "",
      cues: [],
      startsAtMs: 0,
      notice: null,
      ready: false,
      ...patch,
    };
    segments[index] = created;
    audio[index] = audio[index] ?? [];
    timeline.setLength(index, 0);
    return created;
  };

  async function readEvents(): Promise<void> {
    const counts = new Map<number, number>();
    for await (const event of options.events) {
      if (stopped) break;
      if (event.type === "sentence") {
        const at = counts.get(event.segment) ?? 0;
        counts.set(event.segment, at + 1);
        const segment = ensureSegment(event.segment);
        segment.text = segment.text ? `${segment.text} ${event.text}` : event.text;
        enqueue({ segment: event.segment, sentence: at, text: event.text });
      }
      if (event.type === "segment") {
        closed.add(event.segment.index);
        ensureSegment(event.segment.index, {
          kind: event.segment.kind,
          cues: event.segment.cues,
          text: event.segment.text,
        });
        markReady(event.segment.index);
      }
      if (event.type === "leak") {
        // A leak is not a silent Segment — #1 falls back to speaking its Cue — but it is a Segment
        // whose description was thrown away, and the listener is owed that before hearing it.
        ensureSegment(event.segment, {
          notice: `segment ${event.segment} leaked ${event.leaks.map((leak) => leak.kind).join(", ")} and speaks its cue instead`,
        });
      }
      publish();
    }
    eventsDone = true;
    queued?.();
    queued = null;
  }

  /**
   * Stays alive after the queue drains, rather than returning.
   *
   * `r` puts a failed sentence back on the queue, and a worker that had already exited would take
   * the request silently — the Narration would sit halted for ever with nothing coming. So the end
   * of the queue is a state (`synthesized`), not the end of the loop.
   */
  async function synthesize(): Promise<void> {
    while (!isStopped()) {
      const next = queue.shift();
      if (!next) {
        if (eventsDone && !synthesized) {
          synthesized = true;
          nudge();
          publish();
        }
        await new Promise<void>((resolve) => {
          queued = resolve;
        });
        continue;
      }
      await speakOne(next);
      markReady(next.segment);
    }
  }

  /**
   * How much of a Segment can be played: its sentences, in order, stopping at the first one that has
   * no audio yet and is still owed some.
   *
   * The stop is what keeps the timeline honest while a Segment is being filled in out of order —
   * which is what `r` does, re-synthesizing sentence two while three and four already have audio.
   * Summing every slot instead would quietly pull the later sentences into the gap, so playback
   * would speak sentence four where two belongs and then shift under itself when two arrived.
   */
  function playableLength(index: number): number {
    let total = 0;
    const sentences = audio[index] ?? [];
    for (let at = 0; at < sentences.length; at++) {
      const chunks = sentences[at] ?? [];
      if (chunks.length === 0 && owed.has(`${index}:${at}`)) break;
      for (const chunk of chunks) total += chunk.length;
    }
    return total;
  }

  /** A Segment is ready when it has closed and nothing of it is still waiting to be spoken. */
  function markReady(index: number): void {
    const segment = segments[index];
    if (!segment || !closed.has(index)) return;
    if (queue.some((item) => item.segment === index)) return;
    segment.ready = !failed.some((item) => item.segment === index);
    if (segment.ready) rest(index, segment.kind);
  }

  /** The Segment has said everything it is going to say; give the listener a moment before the next. */
  function rest(index: number, kind: BlockKind): void {
    if (rested.has(index)) return;
    rested.add(index);
    const sentences = (audio[index] = audio[index] ?? []);
    const ms = kind === "beat" ? PAUSE_AFTER_BEAT_MS : PAUSE_AFTER_SEGMENT_MS;
    // Its own slot at the end, so it is never confused for a sentence that could be re-synthesized.
    sentences.push([new Uint8Array(msToBytes(ms))]);
    timeline.setLength(index, playableLength(index));
    nudge();
    publish();
  }

  async function speakOne(item: PendingSentence): Promise<void> {
    const digest = earCopyDigest(item.text, options.speech.voice, options.speech.engine);
    /** This sentence's slot, emptied first so a retry replaces what failed rather than following it. */
    const slot = (): Uint8Array[] => {
      const sentences = (audio[item.segment] = audio[item.segment] ?? []);
      return (sentences[item.sentence] = sentences[item.sentence] ?? []);
    };
    const measure = (): void => {
      timeline.setLength(item.segment, playableLength(item.segment));
      nudge();
      publish();
    };
    const append = (pcm: Uint8Array): void => {
      slot().push(pcm);
      measure();
    };

    slot().length = 0;
    measure();

    const cached = await options.cache?.read(item.segment, item.sentence, digest);
    if (cached && cached.length > 0) {
      owed.delete(`${item.segment}:${item.sentence}`);
      append(cached);
      return;
    }

    const chunks: Uint8Array[] = [];
    try {
      for await (const chunk of options.speech.speak(item.text)) {
        if (stopped) return;
        chunks.push(chunk);
        append(chunk);
      }
    } catch (error) {
      // Whatever arrived before it threw is thrown away with it. Half a sentence is not something
      // to speak, and leaving it would make the retry a second copy rather than the sentence.
      slot().length = 0;
      measure();
      // Held, not dropped: `r` puts it back on the queue, and the Segment is not spoken meanwhile.
      failed.push(item);
      ensureSegment(item.segment, {
        notice: `segment ${item.segment} failed to synthesize (${message(error)}) — press r`,
      });
      nudge();
      publish();
      return;
    }
    owed.delete(`${item.segment}:${item.sentence}`);
    measure();
    await options.cache?.write(item.segment, item.sentence, digest, concat(chunks));
  }

  // --- the Transport ---------------------------------------------------------------------------

  const move = (to: Position): void => {
    reanchor(timeline.absolute(to));
    halted = null;
    finished = false;
    restart();
    publish();
  };

  const player: NarrationPlayer = {
    state: snapshot,
    toggle() {
      if (halted) return player.retry();
      // Read before the flip: `positionBytes` answers differently once `playing` is false, so
      // toggling first and re-anchoring after would pause at wherever the last run began.
      const at = positionBytes();
      playing = !playing;
      finished = false;
      reanchor(at);
      restart();
      publish();
    },
    back: () => move(timeline.seek(timeline.at(positionBytes()), -SEEK_STEP_MS)),
    forward: () => move(timeline.seek(timeline.at(positionBytes()), SEEK_STEP_MS)),
    nextSegment: () => move(timeline.nextSegment(timeline.at(positionBytes()))),
    prevSegment: () => move(timeline.prevSegment(timeline.at(positionBytes()))),
    slower() {
      tempo = round(Math.max(TEMPO_MIN, tempo - TEMPO_STEP));
      reanchor();
      restart();
      publish();
    },
    faster() {
      tempo = round(Math.min(TEMPO_MAX, tempo + TEMPO_STEP));
      reanchor();
      restart();
      publish();
    },
    retry() {
      const here = timeline.at(positionBytes()).segment;
      const stuck = segments.find(
        (segment) => segment?.notice && !acknowledged.has(segment.index) && segment.index >= here,
      );
      if (stuck) {
        acknowledged.add(stuck.index);
        for (let i = failed.length - 1; i >= 0; i--) {
          const item = failed[i];
          if (item?.segment !== stuck.index) continue;
          failed.splice(i, 1);
          enqueue(item);
        }
      }
      halted = null;
      playing = true;
      finished = false;
      reanchor();
      restart();
      publish();
    },
    note(text) {
      halted = text;
      playing = false;
      reanchor();
      sounding = false;
      generation += 1;
      run?.kill();
      run = null;
      publish();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      playing = false;
      sounding = false;
      generation += 1;
      run?.kill();
      run = null;
      nudge();
      queued?.();
      publish();
      resolveDone();
    },
    done,
  };

  /** The screen's own clock. Only while something is actually being spoken — a paused Player, a
   * halted one and a finished one all show something that is not changing. */
  async function redraw(every: number): Promise<void> {
    while (!stopped) {
      await wait(every);
      if (sounding && playing) publish();
    }
  }

  // Both halves start at once: the rewrite is already streaming, and the synthesizer must not wait
  // for it to finish (ADR 0001 — sequential is ~4s to the first word and misses the budget).
  void readEvents();
  void synthesize();
  if (options.redrawMs) void redraw(options.redrawMs);
  playing = true;
  reanchor(0);
  void pump(generation);

  return player;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
