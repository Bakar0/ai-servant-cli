// Reading a yes or no off what the user answered — a transcript, or a typed line. This is what the Guarded gate turns on, so it is
// deliberately strict and deliberately not a model call: a misheard sentence must never be able to
// launch runaway work (workspace ADR 0009, majordomo#17).

export type Confirmation = "affirmative" | "negative" | "unclear";

/**
 * Words that carry no decision, dropped before matching so "um, yes please" reads as "yes".
 * Kept short on purpose — anything that could *be* the answer stays.
 */
const FILLER = new Set(["um", "uh", "erm", "er", "hmm", "well", "please", "just", "a", "the"]);

const AFFIRMATIVE = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "aye",
  "ok",
  "okay",
  "sure",
  "absolutely",
  "definitely",
  "certainly",
  "correct",
  "confirm",
  "confirmed",
  "affirmative",
  "go",
  "go ahead",
  "go for it",
  "do it",
  "do that",
  "lets do it",
  "let us do it",
  "sounds good",
  "send it",
  "ship it",
];

const NEGATIVE = [
  "no",
  "nope",
  "nah",
  "negative",
  "dont",
  "do not",
  "stop",
  "cancel",
  "abort",
  "wait",
  "hold on",
  "hold off",
  "never mind",
  "nevermind",
  "not now",
  "not yet",
  "forget it",
  "skip it",
  "leave it",
  "no thanks",
  "dont bother",
];

/** Longest phrases first, so "go ahead" is consumed as one answer rather than "go" plus a leftover. */
const byLongest = (phrases: readonly string[]): string[][] =>
  phrases.map((p) => p.split(" ")).toSorted((a, b) => b.length - a.length);

const AFFIRMATIVE_PHRASES = byLongest(AFFIRMATIVE);
const NEGATIVE_PHRASES = byLongest(NEGATIVE);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0 && !FILLER.has(w));
}

/**
 * True only when the whole utterance is made of these phrases and nothing else. Containment would
 * be far too loose — "I said yes to the other thing" contains "yes" and must not confirm anything.
 */
function entirely(answer: readonly string[], phrases: readonly string[][]): boolean {
  let i = 0;
  while (i < answer.length) {
    const match = phrases.find((p) => p.every((word, k) => answer[i + k] === word));
    if (!match) return false;
    i += match.length;
  }
  return true;
}

/**
 * Classify an answer to a confirmation question. Anything that is not unambiguously one or
 * the other — a mixed answer, a sentence, silence, an unrelated remark — is `"unclear"`, and the
 * caller treats that exactly like a decline.
 */
export function classifyConfirmation(text: string): Confirmation {
  const answer = words(text);
  if (answer.length === 0) return "unclear";
  if (entirely(answer, NEGATIVE_PHRASES)) return "negative";
  if (entirely(answer, AFFIRMATIVE_PHRASES)) return "affirmative";
  return "unclear";
}
