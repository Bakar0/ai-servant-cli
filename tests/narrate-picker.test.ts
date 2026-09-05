// The Turn picker, driven through a fake fzf. Two of these tests are the feature: a fragment
// copied off a terminal arrives hard-wrapped, and fuzzy matching across a whole reply is useless.

import { describe, expect, test } from "bun:test";
import { flatten } from "../src/core/narrate-turn.ts";
import type { Turn } from "../src/core/narrate-turn.ts";
import { pickTurn, turnLabel, turnPickerLine } from "../src/ui/narrate-picker.ts";

function turn(index: number, prompt: string, markdown: string): Turn {
  return {
    uuid: `uuid-${index}`,
    index,
    prompt,
    markdown,
    startedAtMs: Date.now() - 60_000,
    entries: 1,
    complete: true,
  };
}

const TURNS = [
  turn(0, "why a pipeline?", "Because Transport is impossible over\na live socket."),
  turn(1, "what did it cost?", "About a second of latency, bought back by Pre-warm."),
];

describe("what fzf is given", () => {
  test("the line carries a hidden key, a label, and the whole body", () => {
    const [key, label, body] = turnPickerLine(TURNS[0] as Turn).split("\t");
    expect(key).toBe("0");
    expect(label).toContain("why a pipeline?");
    expect(body).toBe("why a pipeline? Because Transport is impossible over a live socket.");
  });

  test("the haystack is one line, so a wrapped paste can match it", () => {
    const body = turnPickerLine(TURNS[0] as Turn).split("\t")[2] ?? "";
    expect(body).not.toContain("\n");
    // What lands in the query when a wrapped fragment is pasted, normalized the same way.
    expect(body).toContain(flatten("Transport is impossible over\na live socket"));
  });

  test("the label is short — the matching happens against the body behind it", () => {
    expect(turnLabel(TURNS[1] as Turn)).toContain("what did it cost?");
    expect(turnLabel(TURNS[1] as Turn)).toContain("words");
  });

  test("matching is exact by default, with a key that makes it fuzzy", async () => {
    let args: string[] = [];
    await pickTurn([...TURNS], {
      run: async (given) => {
        args = given;
        return { code: 1, stdout: "" };
      },
    });
    expect(args).toContain("--exact");
    expect(args.some((arg) => arg.startsWith("--bind=ctrl-f:"))).toBe(true);
  });

  test("what is shown and what is searched are different fields", async () => {
    let args: string[] = [];
    await pickTurn([...TURNS], {
      run: async (given) => {
        args = given;
        return { code: 1, stdout: "" };
      },
    });
    expect(args).toContain("--with-nth=2");
    expect(args).toContain("--nth=2..");
  });
});

describe("what comes back", () => {
  test("the selected line maps back to its Turn by the hidden key", async () => {
    const picked = await pickTurn([...TURNS], {
      run: async () => ({ code: 0, stdout: `${turnPickerLine(TURNS[1] as Turn)}\n` }),
    });
    expect(picked?.index).toBe(1);
  });

  test("cancelling picks nothing", async () => {
    expect(await pickTurn([...TURNS], { run: async () => ({ code: 130, stdout: "" }) })).toBeNull();
  });

  test("nothing to pick from is not an error", async () => {
    expect(
      await pickTurn([], {
        run: async () => {
          throw new Error("fzf should not have been run");
        },
      }),
    ).toBeNull();
  });
});
