import { describe, expect, test } from "bun:test";
import { classifyConfirmation } from "../src/core/summons-confirm.ts";

describe("hearing a yes", () => {
  test.each([
    "yes",
    "Yes.",
    "yeah",
    "yep",
    "sure",
    "ok",
    "Okay!",
    "go ahead",
    "yes, go ahead",
    "do it",
    "um, yes please",
    "absolutely",
    "confirmed",
    "let's do it",
  ])("%p confirms", (utterance) => {
    expect(classifyConfirmation(utterance)).toBe("affirmative");
  });
});

describe("hearing a no", () => {
  test.each([
    "no",
    "No.",
    "nope",
    "nah",
    "don't",
    "do not",
    "stop",
    "cancel",
    "wait",
    "hold on",
    "never mind",
    "not now",
    "no thanks",
  ])("%p declines", (utterance) => {
    expect(classifyConfirmation(utterance)).toBe("negative");
  });
});

describe("anything else is unclear, and the caller declines it", () => {
  test.each([
    "",
    "   ",
    "I said yes to the other thing",
    "yes but not the migrations",
    "what did you say?",
    "hang on, what does that touch?",
    "yes no",
    "maybe",
    "not really",
    "sorry, my phone",
  ])("%p is unclear", (utterance) => {
    expect(classifyConfirmation(utterance)).toBe("unclear");
  });

  test("a whole sentence that happens to open with yes does not confirm", () => {
    // The gate must not fire on a sentence about something else entirely.
    expect(classifyConfirmation("yes, the parser is the one that keeps breaking")).toBe("unclear");
  });
});
