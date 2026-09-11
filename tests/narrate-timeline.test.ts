// The Transport's arithmetic, with no audio anywhere near it. Everything a control promises about
// its own units — that ±5s is five seconds, that it crosses Segment boundaries, that it clamps
// rather than wrapping — is decided here, so it is decided in a test that runs in a millisecond.

import { describe, expect, test } from "bun:test";
import { NARRATION_BYTES_PER_MS, msToBytes } from "../src/core/narrate-voice.ts";
import { SEEK_STEP_MS, SEGMENT_RESTART_MS, createTimeline } from "../src/core/narrate-timeline.ts";

/** Three Segments of one second each, which makes every expectation below readable as seconds. */
function threeSeconds() {
  const timeline = createTimeline();
  timeline.setLength(0, msToBytes(1000));
  timeline.setLength(1, msToBytes(1000));
  timeline.setLength(2, msToBytes(1000));
  return timeline;
}

describe("the concatenated Segment timeline", () => {
  test("a position is a Segment and a byte offset inside it", () => {
    const timeline = threeSeconds();
    expect(timeline.at(msToBytes(1500))).toEqual({ segment: 1, offset: msToBytes(500) });
  });

  test("the end of a Segment and the start of the next are the same instant", () => {
    const timeline = threeSeconds();
    expect(timeline.absolute({ segment: 1, offset: 0 })).toBe(msToBytes(1000));
  });

  test("total duration is every Segment, in milliseconds", () => {
    expect(threeSeconds().totalMs()).toBe(3000);
  });

  test("an empty timeline has a position and it is zero", () => {
    const timeline = createTimeline();
    expect(timeline.at(0)).toEqual({ segment: 0, offset: 0 });
    expect(timeline.totalMs()).toBe(0);
  });
});

describe("back five seconds", () => {
  test("crosses backwards into the previous Segment rather than snapping to its start", () => {
    const timeline = createTimeline();
    timeline.setLength(0, msToBytes(10_000));
    timeline.setLength(1, msToBytes(10_000));
    const from = { segment: 1, offset: msToBytes(2000) };
    expect(timeline.seek(from, -SEEK_STEP_MS)).toEqual({
      segment: 0,
      offset: msToBytes(7000),
    });
  });

  test("is exactly five seconds, not a Segment edge", () => {
    const timeline = createTimeline();
    timeline.setLength(0, msToBytes(30_000));
    const from = { segment: 0, offset: msToBytes(20_000) };
    const moved = timeline.absolute(timeline.seek(from, -SEEK_STEP_MS));
    expect((msToBytes(20_000) - moved) / NARRATION_BYTES_PER_MS).toBe(5000);
  });

  test("clamps at the beginning instead of wrapping to the end", () => {
    const timeline = threeSeconds();
    expect(timeline.seek({ segment: 0, offset: msToBytes(300) }, -SEEK_STEP_MS)).toEqual({
      segment: 0,
      offset: 0,
    });
  });

  test("forward clamps at the end of what has been synthesized so far", () => {
    const timeline = threeSeconds();
    const moved = timeline.seek({ segment: 2, offset: msToBytes(900) }, SEEK_STEP_MS);
    expect(timeline.absolute(moved)).toBe(timeline.totalBytes());
  });
});

describe("Segment skip", () => {
  test("next goes to the start of the next Segment", () => {
    const timeline = threeSeconds();
    expect(timeline.nextSegment({ segment: 0, offset: msToBytes(400) })).toEqual({
      segment: 1,
      offset: 0,
    });
  });

  test("next from the last Segment stays put rather than falling off the end", () => {
    const timeline = threeSeconds();
    expect(timeline.nextSegment({ segment: 2, offset: msToBytes(400) })).toEqual({
      segment: 2,
      offset: msToBytes(400),
    });
  });

  test("prev restarts the Segment you are in the middle of", () => {
    const timeline = threeSeconds();
    timeline.setLength(1, msToBytes(10_000));
    expect(timeline.prevSegment({ segment: 1, offset: msToBytes(SEGMENT_RESTART_MS) })).toEqual({
      segment: 1,
      offset: 0,
    });
  });

  test("prev at the head of a Segment goes to the one before it", () => {
    const timeline = threeSeconds();
    timeline.setLength(1, msToBytes(10_000));
    expect(timeline.prevSegment({ segment: 1, offset: msToBytes(SEGMENT_RESTART_MS - 1) })).toEqual(
      { segment: 0, offset: 0 },
    );
  });

  test("prev at the very start of the Narration stays at zero", () => {
    const timeline = threeSeconds();
    expect(timeline.prevSegment({ segment: 0, offset: 0 })).toEqual({ segment: 0, offset: 0 });
  });
});

describe("a timeline that is still growing", () => {
  test("a Segment lengthening under a position leaves the position where it was", () => {
    const timeline = createTimeline();
    timeline.setLength(0, msToBytes(1000));
    const before = timeline.absolute({ segment: 0, offset: msToBytes(500) });
    timeline.setLength(0, msToBytes(4000));
    expect(timeline.absolute({ segment: 0, offset: msToBytes(500) })).toBe(before);
  });

  test("a position past everything synthesized so far reads as the end", () => {
    const timeline = createTimeline();
    timeline.setLength(0, msToBytes(1000));
    expect(timeline.at(msToBytes(9999))).toEqual({ segment: 0, offset: msToBytes(1000) });
  });

  test("a Segment with no audio yet is skipped over rather than swallowing the position", () => {
    const timeline = createTimeline();
    timeline.setLength(0, msToBytes(1000));
    timeline.setLength(1, 0);
    timeline.setLength(2, msToBytes(1000));
    expect(timeline.at(msToBytes(1500))).toEqual({ segment: 2, offset: msToBytes(500) });
  });
});
