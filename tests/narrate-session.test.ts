// Turning a transcript into one continuous stream of Segments, including while the Turn is still
// being written. The Segment numbering is the whole of it: two batches that both start at zero
// would overwrite the first half of the Narration on screen and in the timeline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { narrateTurnStream, newestSessionForCwd } from "../src/core/narrate-session.ts";
import { readTurns } from "../src/core/narrate-turn.ts";
import type { NarrationEvent } from "../src/core/narrate.ts";

let dir = "";
let projects = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "servant-narrate-session-"));
  projects = join(dir, "projects");
  process.env.CLAUDE_PROJECTS_ROOT = projects;
});

afterEach(async () => {
  process.env.CLAUDE_PROJECTS_ROOT = undefined;
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
function uuid(): string {
  counter += 1;
  return `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
}

function said(text: string) {
  return { type: "user", uuid: uuid(), message: { role: "user", content: text } };
}

function replied(text: string, stop: string | null = "end_turn") {
  return {
    type: "assistant",
    uuid: uuid(),
    timestamp: "2026-09-05T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }], stop_reason: stop },
  };
}

async function write(path: string, records: unknown[]): Promise<string> {
  await Bun.write(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

async function collect(stream: AsyncIterable<NarrationEvent>): Promise<NarrationEvent[]> {
  const events: NarrationEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("which transcript", () => {
  test("the newest one written for this directory", async () => {
    const slug = join(projects, "-some-project");
    await write(join(slug, "aaaaaaaa-0000-0000-0000-000000000000.jsonl"), [
      said("a"),
      replied("A"),
    ]);
    await Bun.sleep(10);
    const newer = await write(join(slug, "bbbbbbbb-0000-0000-0000-000000000000.jsonl"), [
      said("b"),
      replied("B"),
    ]);
    const found = await newestSessionForCwd("/some/project");
    expect(found?.jsonlPath).toBe(newer);
    expect(found?.sessionId).toBe("bbbbbbbb-0000-0000-0000-000000000000");
  });

  test("a directory with no sessions answers nothing rather than throwing", async () => {
    expect(await newestSessionForCwd("/nowhere/at/all")).toBeNull();
  });
});

describe("a Turn as Segments", () => {
  test("a finished Turn is narrated once, numbered from zero", async () => {
    const path = await write(join(dir, "one.jsonl"), [
      said("go"),
      replied("First paragraph.\n\nSecond paragraph."),
    ]);
    const turn = (await readTurns(path))[0];
    const events = await collect(narrateTurnStream(path, turn as never));
    expect(
      events
        .filter((e) => e.type === "segment")
        .map((e) => (e as never as { segment: { index: number } }).segment.index),
    ).toEqual([0, 1]);
  });

  test("a growing Turn keeps counting, rather than starting again at zero", async () => {
    const path = join(dir, "growing.jsonl");
    const user = said("go");
    const first = replied("First paragraph.", "tool_use");
    await write(path, [user, first]);
    const turn = (await readTurns(path))[0];

    let grown = false;
    const wait = async (): Promise<void> => {
      if (grown) return;
      grown = true;
      await write(path, [user, first, replied("Second paragraph.\n\nThird paragraph.")]);
    };

    const events = await collect(narrateTurnStream(path, turn as never, { follow: true, wait }));
    const indices = events
      .filter((event) => event.type === "segment")
      .map((event) => (event as never as { segment: { index: number } }).segment.index);
    expect(indices).toEqual([0, 1, 2]);
  });

  test("a Turn still running is followed without being asked", async () => {
    const path = join(dir, "running.jsonl");
    const user = said("go");
    const first = replied("One.", "tool_use");
    await write(path, [user, first]);
    const turn = (await readTurns(path))[0];
    let grown = false;
    const events = await collect(
      narrateTurnStream(path, turn as never, {
        wait: async () => {
          if (grown) return;
          grown = true;
          await write(path, [user, first, replied("Two.")]);
        },
      }),
    );
    expect(events.filter((event) => event.type === "segment")).toHaveLength(2);
  });
});
