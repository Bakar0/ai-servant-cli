import { describe, expect, test } from "bun:test";
import {
  assertSpeakable,
  classifyUnspeakable,
  findLeaks,
  isConversationalOffer,
  NarrationLeakError,
} from "../src/core/narrate-leak.ts";

describe("Ear-copy that leaks something unspeakable", () => {
  test.each([
    ["a path", "The change lives in src/core/narrate.ts near the top."],
    ["an absolute path", "It reads /etc/hosts before anything else."],
    ["a home path", "The key is in ~/.ai_servant/.env."],
    ["a bare filename", "Look at README.md for the rest."],
    ["a url", "The docs are at https://bun.sh/docs for reference."],
    ["a bare host", "It posts to www.example.com every minute."],
    ["a commit hash", "The base already contains 21d1608 so it is current."],
    ["a long identifier", "The session is 4991f03a8d934460b3cf68ce22f1 right now."],
    ["a leftover fence", "It shows ```ts at the start."],
  ])("%s fails", (_name, text) => {
    expect(findLeaks(text)).not.toBeEmpty();
    expect(() => assertSpeakable(text, "segment 0")).toThrow(NarrationLeakError);
  });

  test("the error names where it happened and what leaked", () => {
    try {
      assertSpeakable("It lives in src/core/narrate.ts.", "segment 3");
      throw new Error("expected a leak");
    } catch (error) {
      expect(error).toBeInstanceOf(NarrationLeakError);
      const leak = error as NarrationLeakError;
      expect(leak.where).toBe("segment 3");
      expect(leak.leaks[0]?.kind).toBe("path");
      expect(leak.message).toContain("src/core/narrate.ts");
    }
  });
});

describe("Ear-copy that is safe to speak", () => {
  test.each([
    "There's a file path here, and a code block just under it.",
    "The rewrite took between three and four seconds, so about 3.0 to 4.2.",
    "It reads and/or writes, depending on the flag.",
    "Pass the dangerously-skip-permissions flag and it stops asking.",
    "Nine out of ten runs finished, so 9/10.",
    "The model is gpt-4o-mini, and it declined to read paths aloud.",
    "He defaced the wall, which is a word made only of hex letters.",
  ])("%p passes", (text) => {
    expect(findLeaks(text)).toBeEmpty();
    expect(() => assertSpeakable(text, "segment 0")).not.toThrow();
  });
});

describe("classifying a token on the way in", () => {
  test.each([
    ["src/core/narrate.ts", "path"],
    ["docs/adr", "path"],
    ["README.md", "path"],
    ["./scripts/build.sh", "path"],
    ["https://example.com/a", "url"],
    ["21d1608", "hash"],
    ["b05c318a1f2e4d", "hash"],
    ["new-spech-ability-03j6", "identifier"],
  ])("%p is %p", (token, kind) => {
    expect(classifyUnspeakable(token)).toBe(kind as never);
  });

  test.each(["narrate", "gpt-4o-mini", "--verbose", "Turn", "and/or", "9/10"])(
    "%p is speakable",
    (token) => {
      expect(classifyUnspeakable(token)).toBeNull();
    },
  );

  test("the rules are stricter than the validator, on purpose", () => {
    // The rules substitute, so over-reaching costs a noun phrase. The validator kills the
    // Narration, so it only fires on what is unambiguously unspeakable.
    expect(classifyUnspeakable("docs/adr")).toBe("path");
    expect(findLeaks("It is under docs/adr somewhere.")).toBeEmpty();
  });
});

describe("a narration that turns conversational", () => {
  test.each([
    "If you want, I can walk through the failing test next.",
    "Let me know if you'd like me to expand on that.",
    "Would you like me to run the suite?",
    "Want me to keep going?",
    "Just say the word and I'll dig in.",
    "I can also: (a) rerun it, or (b) skip it.",
    "Shall I continue?",
  ])("%p is an offer, not narration", (sentence) => {
    expect(isConversationalOffer(sentence)).toBe(true);
  });

  test.each([
    "There's a table here comparing three approaches.",
    "The validator fails the segment rather than speaking it.",
    "If you want the short version, the rewrite is streamed.",
    "Let me know is what the model said, quoted inside the reply.",
  ])("%p is narration", (sentence) => {
    expect(isConversationalOffer(sentence)).toBe(false);
  });
});
