import { describe, expect, test } from "bun:test";
import { findLeaks, isConversationalOffer } from "../src/core/narrate-leak.ts";
import { narrateToSegments } from "../src/core/narrate.ts";
import type { EarCopyModel } from "../src/core/narrate.ts";

// Real model output, recorded once on 2026-09-05 against the prompt in narrate-ear-copy.ts with
// the section heading "Where it stands", and frozen here so the suite stays offline. Replaying a
// recording is what catches the pipeline drifting: a cut in the wrong place, a leak walked past,
// a narration that turns conversational.

function replay(recording: string): EarCopyModel {
  return {
    async *stream() {
      for (let at = 0; at < recording.length; at += 11) yield recording.slice(at, at + 11);
    },
  };
}

const PARAGRAPH = [
  "The fix landed in `src/core/narrate-leak.ts` at commit 21d1608, and it is the half of the",
  "guarantee that runs on the way out. The rules layer already replaced every path before the",
  "model saw the text, so what the validator catches is the model writing one of its own —",
  "see https://bun.sh/docs for how the stream is read.",
].join("\n");

const FENCE = [
  "```ts",
  "export function findLeaks(text: string): Leak[] {",
  "  return text.split(/\\s+/).flatMap(classify);",
  "}",
  "```",
].join("\n");

const TABLE = [
  "| model | rewrite | verdict |",
  "|---|---|---|",
  "| gpt-4o-mini | 3.0-4.2s | good |",
  "| gpt-5-mini | 17.5-19.3s | rejected |",
].join("\n");

describe("gpt-4o-mini, recorded (3.0-7.2s per block)", () => {
  test("a paragraph comes back as four spoken sentences, and none of them leaks", async () => {
    const recording =
      "The fix was added to the narrate leak file, and it represents half of the guarantee that operates during the exit process. The rules layer has already updated every path before the model processes the text. Therefore, what the validator detects is the model generating one of its own. There is additional information available on how the stream is read.";
    const segments = await narrateToSegments(PARAGRAPH, { model: replay(recording) });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe(recording);
    expect(findLeaks(segments[0]?.text ?? "")).toBeEmpty();
    expect(segments[0]?.cues.map((cue) => cue.node)).toEqual(["path", "hash", "url"]);
  });

  test("a code fence comes back as one sentence about it, never as the code", async () => {
    const recording =
      "This section shows a function that takes a string as input and returns an array of classified leaks by splitting the text into words.";
    const segments = await narrateToSegments(FENCE, { model: replay(recording) });
    expect(segments[0]).toMatchObject({ kind: "description", text: recording });
    expect(segments[0]?.text).not.toContain("findLeaks");
  });

  test("a table comes back described, not read across", async () => {
    const recording =
      "This section presents a comparison of different models, their rewrite times, and the corresponding verdicts on their performance.";
    const segments = await narrateToSegments(TABLE, { model: replay(recording) });
    expect(segments[0]).toMatchObject({ kind: "description", text: recording });
    expect(findLeaks(segments[0]?.text ?? "")).toBeEmpty();
  });
});

describe("gpt-5-mini, recorded (9.4-15.6s per block — rejected on speed)", () => {
  test("its rewrite is good, and still costs three times the budget", async () => {
    const recording =
      "On screen: the fix landed in the narrate leak file, and the commit is shown as a commit hash. It provides the outgoing half of the guarantee. The rules layer had already replaced every path before the model saw the text, so the validator is catching cases where the model writes one of its own. There’s a link on screen that explains how the stream is read.";
    const segments = await narrateToSegments(PARAGRAPH, { model: replay(recording) });
    expect(segments[0]?.text).toBe(recording);
    expect(findLeaks(segments[0]?.text ?? "")).toBeEmpty();
  });

  test("a narration that turns conversational is cut back to narration", async () => {
    // The shape the ticket recorded from gpt-5-mini before the prompt forbade it. The prompt now
    // suppresses it, which is exactly why the check has to stay: a prompt is not a guarantee.
    const recording =
      "The leak validator is finished and wired into the pipeline. Two tests are still failing on the sentence cutter. If you want, I can: (a) walk through the failures, or (b) move on to the player.";
    const segments = await narrateToSegments("Some prose about the validator.", {
      model: replay(recording),
    });
    expect(
      isConversationalOffer(
        "If you want, I can: (a) walk through the failures, or (b) move on to the player.",
      ),
    ).toBe(true);
    expect(segments[0]?.text).toBe(
      "The leak validator is finished and wired into the pipeline. Two tests are still failing on the sentence cutter.",
    );
  });
});

describe("the recording that proves the rules alone are not enough", () => {
  // gpt-4o-mini, recorded 2026-09-05 against a naive "describe this code block" prompt. The rules
  // layer never touched these paths — a description has to show the model the node — and the model
  // read two of them straight back out. Nothing but the validator stands between this and the ear.
  const recording = [
    "This code block is written in TypeScript and consists of two asynchronous operations that read the contents of two different files.",
    "",
    "1. The first line retrieves the contents of the system's hosts file located at `/etc/hosts`. It uses the `Bun.file()` method to access the file and then calls `.text()` to read its content as a string. The result is stored in the constant variable `hosts`.",
    "",
    "2. The second line reads the content of a markdown file named `0001-ear-copy.md`, which is located in the `docs/adr` directory.",
  ].join("\n");

  const source = [
    "```ts",
    'const hosts = await Bun.file("/etc/hosts").text();',
    'const adr = await Bun.file("docs/adr/0001-ear-copy.md").text();',
    "```",
  ].join("\n");

  test("the leak fails the segment, and the Ear-copy stops at the last safe sentence", async () => {
    const segments = await narrateToSegments(source, { model: replay(recording) });
    expect(segments[0]?.leaked?.map((leak) => leak.kind)).toContain("path");
    expect(segments[0]?.text).not.toContain("/etc/hosts");
    expect(segments[0]?.text).not.toContain("docs/adr");
    expect(segments[0]?.text).toStartWith("This code block is written in TypeScript");
  });
});
