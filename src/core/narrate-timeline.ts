import { bytesToMs, msToBytes } from "./narrate-voice.ts";

// Where the Transport's promises are kept. One Narration's Segments, end to end, as a single
// timeline a position can move along — because "back five seconds" has to mean five seconds of
// speech and not "the start of whatever Segment I am in", and the difference between those two is
// the difference between a control and a lie about a control (workspace CONTEXT.md, Transport).
//
// Nothing here touches audio, a device or a clock. It is arithmetic over byte lengths, which is
// what PCM lets it be: at 48 bytes to the millisecond, a byte offset *is* an instant.

/** What `←` and `→` move. Five seconds, per the ticket, and the one place that number lives. */
export const SEEK_STEP_MS = 5000;

/**
 * How far into a Segment `prev` stops meaning "the one before this" and starts meaning "this one,
 * from the top". The convention every music player has taught, and the alternative — always leaving
 * the Segment you are in — makes it impossible to hear a paragraph twice without seeking by hand.
 */
export const SEGMENT_RESTART_MS = 1500;

/** A point in a Narration: which Segment, and how far into its PCM. */
export interface Position {
  segment: number;
  offset: number;
}

export interface Timeline {
  /** Record how much PCM a Segment has. Called again as a Segment grows under synthesis. */
  setLength(segment: number, bytes: number): void;
  lengthOf(segment: number): number;
  count(): number;
  totalBytes(): number;
  totalMs(): number;
  /** Absolute byte offset from the start of the Narration. */
  absolute(position: Position): number;
  /** The inverse: an absolute offset as a Segment and a position inside it. */
  at(bytes: number): Position;
  msAt(position: Position): number;
  /** Move by ±milliseconds along the whole timeline, clamped at both ends. */
  seek(position: Position, deltaMs: number): Position;
  nextSegment(position: Position): Position;
  prevSegment(position: Position): Position;
}

export function createTimeline(): Timeline {
  const lengths: number[] = [];

  /** Absent Segments read as empty, so a timeline can be filled in any order without a hole. */
  const lengthOf = (segment: number): number => lengths[segment] ?? 0;

  const totalBytes = (): number => lengths.reduce((sum, n) => sum + (n ?? 0), 0);

  const absolute = (position: Position): number => {
    let sum = 0;
    for (let i = 0; i < position.segment; i++) sum += lengthOf(i);
    return sum + clamp(position.offset, 0, lengthOf(position.segment));
  };

  /**
   * An offset lands in the first Segment that still has room for it, which is what makes a Segment
   * not yet synthesized (length 0) transparent rather than a place the position can get stuck. The
   * boundary case goes to the *later* Segment: the last byte of Segment 1 and the first of Segment
   * 2 are the same instant, and calling it the start of 2 is what lets `at(absolute(p))` round-trip
   * a position sitting at a Segment's head.
   */
  const at = (bytes: number): Position => {
    let remaining = clamp(bytes, 0, totalBytes());
    for (let i = 0; i < lengths.length; i++) {
      const length = lengthOf(i);
      if (remaining < length) return { segment: i, offset: remaining };
      remaining -= length;
    }
    // Past everything there is: the end of the last Segment that has any audio.
    const last = lastNonEmpty(lengths);
    return last === null ? { segment: 0, offset: 0 } : { segment: last, offset: lengthOf(last) };
  };

  return {
    setLength(segment, bytes) {
      for (let i = lengths.length; i < segment; i++) lengths[i] = 0;
      lengths[segment] = Math.max(0, bytes);
    },
    lengthOf,
    count: () => lengths.length,
    totalBytes,
    totalMs: () => bytesToMs(totalBytes()),
    absolute,
    at,
    msAt: (position) => bytesToMs(absolute(position)),
    seek: (position, deltaMs) => at(absolute(position) + msToBytes(deltaMs)),
    nextSegment(position) {
      for (let i = position.segment + 1; i < lengths.length; i++) {
        if (lengthOf(i) > 0) return { segment: i, offset: 0 };
      }
      return position;
    },
    prevSegment(position) {
      if (bytesToMs(position.offset) >= SEGMENT_RESTART_MS) {
        return { segment: position.segment, offset: 0 };
      }
      for (let i = position.segment - 1; i >= 0; i--) {
        if (lengthOf(i) > 0) return { segment: i, offset: 0 };
      }
      return { segment: position.segment, offset: 0 };
    },
  };
}

/** Shared with the Player, whose position is clamped against this module's own answers. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function lastNonEmpty(lengths: number[]): number | null {
  for (let i = lengths.length - 1; i >= 0; i--) {
    if ((lengths[i] ?? 0) > 0) return i;
  }
  return null;
}
