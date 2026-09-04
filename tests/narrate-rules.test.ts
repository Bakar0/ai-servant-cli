import { describe, expect, test } from "bun:test";
import { findLeaks } from "../src/core/narrate-leak.ts";
import { segmentMarkdown } from "../src/core/narrate-rules.ts";
import type { Block } from "../src/core/narrate.ts";

function only(markdown: string): Block {
  const blocks = segmentMarkdown(markdown);
  expect(blocks).toHaveLength(1);
  return blocks[0] as Block;
}

describe("splitting a Turn into blocks", () => {
  test("a blank line ends a block", () => {
    const blocks = segmentMarkdown("First thought.\n\nSecond thought.");
    expect(blocks.map((block) => block.text)).toEqual(["First thought.", "Second thought."]);
    expect(blocks.map((block) => block.index)).toEqual([0, 1]);
  });

  test("a wrapped paragraph is one block", () => {
    expect(only("One idea that runs\nacross two lines.").text).toBe(
      "One idea that runs across two lines.",
    );
  });

  test("a heading is a beat, without its hashes", () => {
    const block = only("## What it does");
    expect(block.kind).toBe("beat");
    expect(block.text).toBe("What it does");
  });

  test("a run of list items is one block", () => {
    const block = only("- first\n- second\n- third");
    expect(block.kind).toBe("prose");
    expect(block.text).toContain("first");
    expect(block.text).toContain("third");
    expect(block.text).not.toContain("- ");
  });

  test("a blockquote is spoken as prose", () => {
    expect(only("> quoted thought").text).toBe("quoted thought");
  });
});

describe("nodes the model has to describe", () => {
  test.each([
    ["a fence", "```ts\nconst x = 1;\n```", "code"],
    ["a mermaid fence", "```mermaid\ngraph TD;\nA-->B;\n```", "diagram"],
    ["an indented block", "    const x = 1;\n    const y = 2;", "code"],
    ["a table", "| a | b |\n|---|---|\n| 1 | 2 |", "table"],
    ["an ASCII diagram", "  ┌─────┐\n  │ box │\n  └─────┘", "diagram"],
  ])("%s becomes a description", (_name, markdown, node) => {
    const block = only(markdown);
    expect(block.kind).toBe("description");
    expect(block.cues).toHaveLength(1);
    expect(block.cues[0]?.node).toBe(node as never);
    expect(block.cues[0]?.fate).toBe("describe");
    expect(block.cues[0]?.say).not.toBeEmpty();
  });

  test("the node itself reaches the model, because it cannot describe what it has not seen", () => {
    const block = only("```ts\nconst answer = 42;\n```");
    expect(block.text).toContain("const answer = 42;");
  });

  test("with no model in the path, the Cue is what gets spoken", () => {
    const block = only("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(block.fallback).toBe(block.cues[0]?.say ?? "");
    expect(findLeaks(block.fallback)).toBeEmpty();
  });
});

describe("decoration at block level", () => {
  test("a horizontal rule leaves no empty block, but is still cued", () => {
    const blocks = segmentMarkdown("Before.\n\n---\n\nAfter.");
    expect(blocks.map((block) => block.text)).toEqual(["Before.", "After."]);
    expect(blocks[1]?.cues[0]).toMatchObject({ node: "rule", fate: "drop" });
  });

  test("a rule with nothing after it still attaches to the Turn it ended", () => {
    const blocks = segmentMarkdown("Last word.\n\n---\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cues.at(-1)).toMatchObject({ node: "rule", fate: "drop" });
  });
});

describe("the guarantee, over a whole Turn", () => {
  const turn = [
    "## Where it stands 🎉",
    "",
    "The fix landed in `src/core/narrate-leak.ts` at 21d1608, and the docs are at",
    "https://bun.sh/docs for reference.",
    "",
    "```ts",
    'const leaked = findLeaks("/etc/hosts");',
    "```",
    "",
    "| case | result |",
    "|---|---|",
    "| path | fails |",
    "",
    "- Run `bun test` first",
    "- Then read [the ADR](docs/adr/0001-ear-copy.md)",
    "",
    "---",
    "",
    "That is all.",
  ].join("\n");

  const blocks = segmentMarkdown(turn);

  test("nothing unspeakable survives into anything that gets spoken", () => {
    for (const block of blocks) {
      if (block.kind !== "description") expect(findLeaks(block.text)).toBeEmpty();
      expect(findLeaks(block.fallback)).toBeEmpty();
    }
  });

  test("every skip is cued, and every cue that stands in for content speaks", () => {
    const cues = blocks.flatMap((block) => block.cues);
    expect(cues.map((cue) => cue.node).toSorted()).toEqual([
      "code",
      "emoji",
      "hash",
      "path",
      "path",
      "rule",
      "table",
      "url",
    ]);
    for (const cue of cues) {
      if (cue.fate === "drop") expect(cue.say).toBe("");
      else expect(cue.say).not.toBeEmpty();
    }
  });

  test("every block keeps the markdown it came from, for the Player to show", () => {
    for (const block of blocks) expect(block.source).not.toBeEmpty();
  });
});
