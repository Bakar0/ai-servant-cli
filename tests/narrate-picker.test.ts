// The Turn picker, driven through a fake fzf. Two of these tests are the feature: a fragment
// copied off a terminal arrives hard-wrapped, and fuzzy matching across a whole reply is useless.

import { describe, expect, test } from "bun:test";
import { flatten } from "../src/core/narrate-turn.ts";
import type { Turn } from "../src/core/narrate-turn.ts";
import { pickTurn, turnLabel, turnPickerLine } from "../src/ui/narrate-picker.ts";

function turn(
  index: number,
  prompt: string,
  markdown: string,
  sessionId = "aaaaaaaa-1111",
  sessionName = "",
): Turn {
  return {
    sessionId,
    sessionName,
    jsonlPath: `/tmp/${sessionId}.jsonl`,
    uuid: `uuid-${index}`,
    index,
    prompt,
    blocks: markdown.split("\n\n"),
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
    const [key, label, body] = turnPickerLine(TURNS[0] as Turn, 0).split("\t");
    expect(key).toBe("0");
    expect(label).toContain("why a pipeline?");
    expect(body).toBe("why a pipeline? Because Transport is impossible over a live socket.");
  });

  test("the haystack is one line, so a wrapped paste can match it", () => {
    const body = turnPickerLine(TURNS[0] as Turn, 0).split("\t")[2] ?? "";
    expect(body).not.toContain("\n");
    // What lands in the query when a wrapped fragment is pasted, normalized the same way.
    expect(body).toContain(flatten("Transport is impossible over\na live socket"));
  });

  test("a fragment handed in whole is ironed out before it is searched for", async () => {
    let args: string[] = [];
    await pickTurn([...TURNS], {
      query: "Transport is impossible over\na live socket",
      run: async (given) => {
        args = given;
        return { code: 1, stdout: "" };
      },
    });
    expect(args).toContain("--query=Transport is impossible over a live socket");
  });

  test("the row names the session by its tab name when it has one", () => {
    expect(turnLabel(turn(0, "go", "One.", "aaaaaaaa-1111", "new-spech-ability-t2"))).toContain(
      "new-spech-ability-t2",
    );
  });

  test("a session that never got a name falls back to its id", () => {
    expect(turnLabel(turn(0, "go", "One.", "abcdef12-3456"))).toContain("abcdef12");
  });

  test("the label is short — the body it is matched against runs off to the right of it", () => {
    expect(turnLabel(TURNS[1] as Turn)).toContain("what did it cost?");
    expect(turnLabel(TURNS[1] as Turn).length).toBeLessThan(90);
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

  test("the body is inside what fzf searches, not merely on the line", async () => {
    let args: string[] = [];
    await pickTurn([...TURNS], {
      run: async (given) => {
        args = given;
        return { code: 1, stdout: "" };
      },
    });
    // The regression this guards: `--with-nth=2` does not hide field 3 from the search, it removes
    // it. fzf matches against the string `--with-nth` builds, so the body was unsearchable and the
    // picker could only find a reply by the question that prompted it — the one thing the ticket
    // says the haystack must not be.
    expect(args).toContain("--with-nth=2..");
    expect(args).not.toContain("--with-nth=2");
  });
});

describe("a haystack that spans sessions", () => {
  test("the hidden key is the row, not the Turn's index in its own session", () => {
    // Every session numbers its Turns from zero, so two sessions' third replies both claim "2".
    const mine = turn(2, "mine", "One.", "aaaaaaaa-1111");
    const theirs = turn(2, "theirs", "Two.", "bbbbbbbb-2222");
    expect(turnPickerLine(mine, 0).split("\t")[0]).toBe("0");
    expect(turnPickerLine(theirs, 1).split("\t")[0]).toBe("1");
  });

  test("the row that comes back is the Turn at that position, whatever its own index says", async () => {
    const rows = [
      turn(2, "mine", "One.", "aaaaaaaa-1111"),
      turn(2, "theirs", "Two.", "bbbbbbbb-2222"),
    ];
    const picked = await pickTurn(rows, {
      run: async () => ({ code: 0, stdout: `${turnPickerLine(rows[1] as Turn, 1)}\n` }),
    });
    expect(picked?.sessionId).toBe("bbbbbbbb-2222");
  });
});

describe("what comes back", () => {
  test("the selected line maps back to its Turn by the hidden key", async () => {
    const picked = await pickTurn([...TURNS], {
      run: async () => ({ code: 0, stdout: `${turnPickerLine(TURNS[1] as Turn, 1)}\n` }),
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
