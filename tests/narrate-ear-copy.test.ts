import { describe, expect, test } from "bun:test";
import { createSentenceCutter, earCopyPrompt } from "../src/core/narrate-ear-copy.ts";
import { segmentMarkdown } from "../src/core/narrate-rules.ts";
import type { Block } from "../src/core/narrate.ts";

function cut(deltas: readonly string[]): string[] {
  const cutter = createSentenceCutter();
  return [...deltas.flatMap((delta) => cutter.push(delta)), ...cutter.flush()];
}

describe("cutting a stream at sentence boundaries", () => {
  test("a sentence is released as soon as it closes, not when the stream ends", () => {
    const cutter = createSentenceCutter();
    expect(cutter.push("The rewrite is streamed. ")).toEqual(["The rewrite is streamed."]);
    expect(cutter.push("The second one is still")).toEqual([]);
    expect(cutter.flush()).toEqual(["The second one is still"]);
  });

  test("deltas that split mid-word still cut in the right place", () => {
    expect(cut(["First ", "part. Sec", "ond part! Third", " part?"])).toEqual([
      "First part.",
      "Second part!",
      "Third part?",
    ]);
  });

  test("an abbreviation is not a sentence end", () => {
    expect(cut(["Some models, e.g. the mini one, are quick. That is the point."])).toEqual([
      "Some models, e.g. the mini one, are quick.",
      "That is the point.",
    ]);
  });

  test("a decimal is not a sentence end", () => {
    expect(cut(["It took 3.0 seconds. Then it stopped."])).toEqual([
      "It took 3.0 seconds.",
      "Then it stopped.",
    ]);
  });

  test("a closing quote after the stop stays with its sentence", () => {
    expect(cut(['It said "no." Then it stopped.'])).toEqual(['It said "no."', "Then it stopped."]);
  });

  test("flushing an empty cutter yields nothing", () => {
    expect(cut(["", "   "])).toEqual([]);
  });

  test("a run with no full stop is cut anyway, so synthesis is never starved", () => {
    const clause = "the pipeline keeps going and going, ";
    const released = createSentenceCutter().push(clause.repeat(12));
    expect(released.length).toBeGreaterThan(0);
    for (const sentence of released) expect(sentence.length).toBeLessThanOrEqual(300);
  });
});

describe("the prompt the rewrite runs on", () => {
  const prose = segmentMarkdown("The fix landed in src/core/narrate.ts today.")[0] as Block;
  const table = segmentMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")[0] as Block;

  test("it says who is listening and what they can already see", () => {
    const { system } = earCopyPrompt(prose, "Where it stands");
    expect(system).toContain("screen");
  });

  test("it forbids the two things the model gets wrong on its own", () => {
    const { system } = earCopyPrompt(prose, "");
    expect(system.toLowerCase()).toContain("never read");
    expect(system.toLowerCase()).toContain("do not offer");
  });

  test("prose is handed over already stripped of anything unspeakable", () => {
    const { user } = earCopyPrompt(prose, "Where it stands");
    expect(user).toContain(prose.text);
    expect(user).not.toContain("src/core/narrate.ts");
    expect(user).toContain("Where it stands");
  });

  test("a description asks for one sentence about a node the model must be shown", () => {
    const { user } = earCopyPrompt(table, "");
    expect(user).toContain("| a | b |");
    expect(user).toContain("one sentence");
  });
});
