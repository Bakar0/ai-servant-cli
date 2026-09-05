// Reading Turns off a transcript, against transcripts written by hand. The shapes below are the
// real ones — a tool result arriving as a "user" entry, a sidechain, a meta entry — because those
// are what a naive reading of "every assistant entry since the last user message" gets wrong.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flatten,
  followTurn,
  haystack,
  latestTurn,
  readTurns,
  toolBeat,
} from "../src/core/narrate-turn.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "servant-narrate-turn-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, "0")}`;
}

function said(text: string): Record<string, unknown> {
  return { type: "user", uuid: uuid(), message: { role: "user", content: text } };
}

function replied(
  content: unknown[],
  stop: string | null = "end_turn",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: uuid(),
    timestamp: "2026-09-05T10:00:00.000Z",
    message: { role: "assistant", content, stop_reason: stop },
    ...extra,
  };
}

function toolResult(): Record<string, unknown> {
  return {
    type: "user",
    uuid: uuid(),
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  };
}

async function transcript(records: Record<string, unknown>[]): Promise<string> {
  const path = join(dir, "session.jsonl");
  await Bun.write(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

describe("what counts as one Turn", () => {
  test("a tool result does not start a new Turn", async () => {
    const path = await transcript([
      said("do the thing"),
      replied([{ type: "text", text: "Starting." }], "tool_use"),
      replied([{ type: "tool_use", name: "Bash" }], "tool_use"),
      toolResult(),
      replied([{ type: "text", text: "Done." }]),
    ]);
    const turns = await readTurns(path);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.markdown).toBe("Starting.\n\nThen ran a command.\n\nDone.");
  });

  test("the next thing the user says does start one", async () => {
    const path = await transcript([
      said("first"),
      replied([{ type: "text", text: "One." }]),
      said("second"),
      replied([{ type: "text", text: "Two." }]),
    ]);
    const turns = await readTurns(path);
    expect(turns.map((turn) => turn.markdown)).toEqual(["One.", "Two."]);
    expect(turns.map((turn) => turn.prompt)).toEqual(["first", "second"]);
  });

  test("a subagent's conversation is not part of the answer on screen", async () => {
    const path = await transcript([
      said("go"),
      replied([{ type: "text", text: "Mine." }], "end_turn"),
      replied([{ type: "text", text: "The subagent's." }], "end_turn", { isSidechain: true }),
    ]);
    expect((await readTurns(path))[0]?.markdown).toBe("Mine.");
  });

  test("a meta entry is the harness talking to itself, not a prompt", async () => {
    const path = await transcript([
      said("go"),
      replied([{ type: "text", text: "One." }], "tool_use"),
      { type: "user", uuid: uuid(), isMeta: true, message: { content: "skill loaded" } },
      replied([{ type: "text", text: "Two." }]),
    ]);
    expect(await readTurns(path)).toHaveLength(1);
  });

  test("thinking is dropped, because it is collapsed on screen too", async () => {
    const path = await transcript([
      said("go"),
      replied([
        { type: "thinking", thinking: "long private reasoning" },
        { type: "text", text: "The answer." },
      ]),
    ]);
    expect((await readTurns(path))[0]?.markdown).toBe("The answer.");
  });

  test("a Turn's uuid is its first assistant entry, so it survives the Turn growing", async () => {
    const first = replied([{ type: "text", text: "One." }], "tool_use");
    const path = await transcript([said("go"), first]);
    const grown = await transcript([said("go"), first, replied([{ type: "text", text: "Two." }])]);
    expect((await readTurns(path))[0]?.uuid).toBe((await readTurns(grown))[0]?.uuid);
  });

  test("a Turn that has only made tool calls is still a Turn", async () => {
    const path = await transcript([
      said("go"),
      replied([{ type: "tool_use", name: "Read" }], "tool_use"),
    ]);
    expect((await readTurns(path))[0]?.markdown).toBe("Read a file.");
  });

  test("the newest Turn is what a bare narrate means", async () => {
    const path = await transcript([
      said("first"),
      replied([{ type: "text", text: "One." }]),
      said("second"),
      replied([{ type: "text", text: "Two." }]),
    ]);
    expect((await latestTurn(path))?.markdown).toBe("Two.");
  });
});

describe("whether a Turn is finished", () => {
  test("stopping to call a tool means more is coming", async () => {
    const path = await transcript([
      said("go"),
      replied([{ type: "tool_use", name: "Bash" }], "tool_use"),
    ]);
    expect((await readTurns(path))[0]?.complete).toBe(false);
  });

  test("an entry with no stop reason yet is not finished either", async () => {
    const path = await transcript([said("go"), replied([{ type: "text", text: "Mid." }], null)]);
    expect((await readTurns(path))[0]?.complete).toBe(false);
  });

  test("end_turn finishes it", async () => {
    const path = await transcript([said("go"), replied([{ type: "text", text: "Done." }])]);
    expect((await readTurns(path))[0]?.complete).toBe(true);
  });
});

describe("tool calls as a beat", () => {
  test("a run of the same tool is counted, not listed", () => {
    expect(toolBeat(["Bash", "Bash", "Bash", "Bash"])).toBe("Then ran four commands.");
  });

  test("different tools are grouped by what they did", () => {
    expect(toolBeat(["Bash", "Read", "Read"])).toBe("Then ran a command and read two files.");
  });

  test("searching is said as searching, whichever tool did it", () => {
    expect(toolBeat(["Grep", "Glob"])).toBe("Then ran two searches.");
  });

  test("three kinds read as a list", () => {
    expect(toolBeat(["Bash", "Read", "Write"])).toBe(
      "Then ran a command, read a file and wrote a file.",
    );
  });

  test("the first beat of a Turn does not refer back to nothing", () => {
    expect(toolBeat(["Bash"], true)).toBe("Ran a command.");
  });

  test("a tool nobody taught it about is said as words", () => {
    expect(toolBeat(["ExcalidrawExport"])).toBe("Then used an excalidraw export tool.");
  });

  test("past ten it stops spelling the number out", () => {
    expect(toolBeat(Array.from({ length: 12 }, () => "Bash"))).toBe("Then ran 12 commands.");
  });
});

describe("following a Turn while it grows", () => {
  test("yields only what has appeared since the last look", async () => {
    const path = join(dir, "growing.jsonl");
    const user = said("go");
    const first = replied([{ type: "text", text: "One." }], "tool_use");
    await Bun.write(path, `${[user, first].map((r) => JSON.stringify(r)).join("\n")}\n`);

    const turn = (await readTurns(path))[0];
    const seen: string[] = [];
    const wait = async (): Promise<void> => {
      const second = replied([{ type: "text", text: "Two." }]);
      await Bun.write(path, `${[user, first, second].map((r) => JSON.stringify(r)).join("\n")}\n`);
    };

    for await (const chunk of followTurn(path, turn?.uuid ?? "", { wait })) seen.push(chunk);
    expect(seen).toEqual(["One.", "Two."]);
  });

  test("stops at the end of the Turn rather than polling for ever", async () => {
    const path = await transcript([said("go"), replied([{ type: "text", text: "Done." }])]);
    const turn = (await readTurns(path))[0];
    let waits = 0;
    const seen: string[] = [];
    for await (const chunk of followTurn(path, turn?.uuid ?? "", {
      wait: async () => {
        waits += 1;
      },
    })) {
      seen.push(chunk);
    }
    expect(seen).toEqual(["Done."]);
    expect(waits).toBe(0);
  });

  test("an abort stops it mid-Turn", async () => {
    const path = await transcript([
      said("go"),
      replied([{ type: "text", text: "One." }], "tool_use"),
    ]);
    const turn = (await readTurns(path))[0];
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const chunk of followTurn(path, turn?.uuid ?? "", {
      signal: controller.signal,
      wait: async () => controller.abort(),
    })) {
      seen.push(chunk);
    }
    expect(seen).toEqual(["One."]);
  });
});

describe("what the picker matches against", () => {
  test("a copied fragment and the haystack are flattened the same way", () => {
    const pasted = "the rewrite is\nstreamed and cut at\nsentence boundaries";
    expect(flatten(pasted)).toBe("the rewrite is streamed and cut at sentence boundaries");
  });

  test("the haystack is the whole body, not a title", async () => {
    const path = await transcript([
      said("why a pipeline?"),
      replied([{ type: "text", text: "Because\nTransport is impossible over a socket." }]),
    ]);
    const turn = (await readTurns(path))[0];
    expect(haystack(turn as never)).toBe(
      "why a pipeline? Because Transport is impossible over a socket.",
    );
  });
});
