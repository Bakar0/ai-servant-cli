import type { Block } from "./narrate.ts";

// The rewrite pass: what the model is asked, and how its stream is chopped into things worth
// synthesizing. Cutting at sentence boundaries rather than waiting for the block to finish is the
// difference between a first spoken word at ~1.5s and at ~4s — measured on a 64-word paragraph.

/** Past this, a clause has to be released on a softer boundary or synthesis sits idle. */
const MAX_SENTENCE_CHARS = 260;

const CLOSERS = "\"')]”’»";
const TERMINALS = ".!?…";
// Deliberately short. "No." and "St." are abbreviations far less often than they are the end of
// a sentence, and a missed cut costs latency while a wrong one splits a sentence in half.
const ABBREVIATIONS = [
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "cf.",
  "fig.",
  "approx.",
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
];

export interface SentenceCutter {
  push(delta: string): string[];
  flush(): string[];
}

export function createSentenceCutter(): SentenceCutter {
  let buffer = "";

  const take = (at: number, out: string[]) => {
    const sentence = buffer.slice(0, at).trim();
    buffer = buffer.slice(at);
    if (sentence) out.push(sentence);
  };

  return {
    push(delta) {
      buffer += delta;
      const out: string[] = [];
      for (let at = sentenceEnd(buffer); at > 0; at = sentenceEnd(buffer)) take(at, out);
      while (buffer.length > MAX_SENTENCE_CHARS) {
        const at = softEnd(buffer);
        if (at <= 0) break;
        take(at, out);
      }
      return out;
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      return rest ? [rest] : [];
    },
  };
}

/** Index just past the end of the first complete sentence in `text`, or -1. */
function sentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (!TERMINALS.includes(text[i] ?? "")) continue;
    let j = i + 1;
    while (j < text.length && CLOSERS.includes(text[j] ?? "")) j++;
    // Nothing after it yet — the stream has to prove this is a boundary and not "3." of "3.0".
    if (j >= text.length || !/\s/.test(text[j] ?? "")) continue;
    const before = text.slice(0, i + 1).toLowerCase();
    if (ABBREVIATIONS.some((abbreviation) => before.endsWith(abbreviation))) continue;
    return j;
  }
  return -1;
}

function softEnd(text: string): number {
  const window = text.slice(0, MAX_SENTENCE_CHARS);
  for (const mark of [", ", "; ", ": ", " — ", " – "]) {
    const at = window.lastIndexOf(mark);
    if (at > 0) return at + mark.length;
  }
  const space = window.lastIndexOf(" ");
  return space > 0 ? space + 1 : -1;
}

const SYSTEM = [
  "You rewrite one piece of a coding assistant's reply so it can be listened to.",
  "The listener is looking at the screen while you speak, so point at what is there instead of",
  "reciting it. Never read a file path, URL, commit hash, long identifier, code block, table or",
  "diagram aloud — say what it is and move on.",
  "Keep it to the substance of the text, in the same order, in plain spoken sentences.",
  "Do not offer to help, do not ask a question, do not add a closing line, and do not mention",
  "that you are narrating. Reply with the narration and nothing else.",
].join(" ");

/** The prompt for one block. `heading` is the beat above it, so a paragraph keeps its bearings. */
export function earCopyPrompt(block: Block, heading: string): { system: string; user: string } {
  const section = heading ? `Section: ${heading}\n\n` : "";
  const instruction =
    block.kind === "description"
      ? "Say in one sentence what this contains, for a listener who can see it on screen. Do not read it out."
      : "Rewrite this for the ear:";
  return { system: SYSTEM, user: `${section}${instruction}\n\n${block.text}` };
}
