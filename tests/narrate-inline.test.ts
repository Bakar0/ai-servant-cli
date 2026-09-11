import { describe, expect, test } from "bun:test";
import { speakInline } from "../src/core/narrate-inline.ts";
import { findLeaks } from "../src/core/narrate-leak.ts";

describe("nodes the rules replace outright", () => {
  test("a path never survives", () => {
    const { text, cues } = speakInline("The change lives in src/core/narrate.ts, near the top.");
    expect(text).not.toContain("src/core/narrate.ts");
    expect(findLeaks(text)).toBeEmpty();
    expect(cues[0]).toMatchObject({
      node: "path",
      fate: "reference",
      source: "src/core/narrate.ts",
    });
  });

  test("a path with speakable words in it is named, not just labelled", () => {
    expect(speakInline("See src/core/narrate.ts for the rest.").text).toBe(
      "See the narrate file for the rest.",
    );
  });

  test("a path that would spell out as noise falls back to a noun phrase", () => {
    expect(speakInline("It landed in 0f3a91b2-notes.md today.").text).toBe(
      "It landed in a file path today.",
    );
  });

  test.each([
    ["a bare url", "Docs are at https://bun.sh/docs today.", "url", "a link"],
    ["a commit hash", "The base contains 21d1608 already.", "hash", "a commit hash"],
    [
      "a long identifier",
      "The branch is new-spech-ability-03j6 now.",
      "identifier",
      "an identifier",
    ],
  ])("%s becomes a noun phrase", (_name, markdown, node, phrase) => {
    const { text, cues } = speakInline(markdown);
    expect(text).toContain(phrase);
    expect(cues[0]).toMatchObject({ node: node as never, fate: "reference", say: phrase });
    expect(findLeaks(text)).toBeEmpty();
  });

  test("a lead-in the phrase already says is not said twice", () => {
    expect(speakInline("The base contains commit 21d1608 already.").text).toBe(
      "The base contains a commit hash already.",
    );
  });

  test("and the sentence keeps its own article when it had one", () => {
    expect(speakInline("Open the file src/core/narrate.ts now.").text).toBe(
      "Open the narrate file now.",
    );
    expect(speakInline("The link https://bun.sh/docs is there.").text).toBe("The link is there.");
  });

  test("an ordinary word in front of a substitution is left alone", () => {
    expect(speakInline("See src/core/narrate.ts for the rest.").text).toBe(
      "See the narrate file for the rest.",
    );
  });

  test("punctuation around a replaced token stays put", () => {
    expect(speakInline("It moved (to src/core/narrate.ts), quietly.").text).toBe(
      "It moved (to the narrate file), quietly.",
    );
  });
});

describe("the order Cues come back in", () => {
  test("they read in source order, not in the order the passes ran", () => {
    const { cues } = speakInline(
      "At 21d1608 see [the ADR](docs/adr/0001.md) and open `src/core/narrate.ts`.",
    );
    expect(cues.map((cue) => cue.source)).toEqual([
      "21d1608",
      "docs/adr/0001.md",
      "src/core/narrate.ts",
    ]);
  });
});

describe("links", () => {
  test("a link is spoken as its own words, and cues the address it hid", () => {
    const { text, cues } = speakInline(
      "Read [the decision record](docs/adr/0001-ear-copy.md) first.",
    );
    expect(text).toBe("Read the decision record first.");
    // The cue names what the address actually was — a link to a file is a path, not a URL.
    expect(cues[0]).toMatchObject({
      node: "path",
      fate: "reference",
      say: "the decision record",
      source: "docs/adr/0001-ear-copy.md",
    });
  });

  test("a link with no words of its own is decoration, and is dropped", () => {
    const { text, cues } = speakInline("Built [](https://example.com/ci) cleanly.");
    expect(text).toBe("Built cleanly.");
    expect(cues[0]).toMatchObject({ fate: "drop", say: "" });
  });
});

describe("inline code", () => {
  test("a plain identifier is read as a word, unquoted", () => {
    const { text, cues } = speakInline("Call `segmentMarkdown` on the markdown.");
    expect(text).toBe("Call segmentMarkdown on the markdown.");
    expect(cues).toBeEmpty();
  });

  test("a call keeps its name and loses its parentheses", () => {
    expect(speakInline("Call `flush()` at the end.").text).toBe("Call flush at the end.");
  });

  test("an unspeakable one is still referenced", () => {
    const { text, cues } = speakInline("Open `src/core/narrate.ts` now.");
    expect(text).toBe("Open the narrate file now.");
    expect(cues[0]?.fate).toBe("reference");
  });
});

describe("decoration", () => {
  test.each([
    ["an emoji", "Shipped 🎉 at last.", "emoji", "Shipped at last."],
    [
      "an image",
      "Status ![build](https://img.example/b.svg) is green.",
      "image",
      "Status is green.",
    ],
    [
      "a badge, which is an image inside a link",
      "Status [![build](https://img.example/b.svg)](https://ci.example) is green.",
      "image",
      "Status is green.",
    ],
  ])("%s is dropped, and still recorded", (_name, markdown, node, spoken) => {
    const { text, cues } = speakInline(markdown);
    expect(text).toBe(spoken);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ node: node as never, fate: "drop", say: "" });
  });

  test("emphasis markers are stripped without a cue", () => {
    const { text, cues } = speakInline("This is **very** _important_ indeed.");
    expect(text).toBe("This is very important indeed.");
    expect(cues).toBeEmpty();
  });

  test("an escaped character is spoken as itself", () => {
    expect(speakInline("A literal \\* star.").text).toBe("A literal * star.");
  });
});
