import { classifyUnspeakable, LEADING_PUNCTUATION, TRAILING_PUNCTUATION } from "./narrate-leak.ts";
import type { Cue, UnspeakableKind } from "./narrate.ts";

// Everything that happens inside a line: what is spoken as written, what is renamed, and what is
// passed over in silence. Split from the block rules because the two change for different
// reasons — block shapes are markdown's grammar, these are choices about how a thing sounds.

function drop(node: UnspeakableKind, source: string): Cue {
  return { node, fate: "drop", say: "", source };
}

function reference(kind: UnspeakableKind, source: string): Cue {
  return { node: kind, fate: "reference", say: nounPhrase(kind, source), source };
}

function nounPhrase(kind: UnspeakableKind, token: string): string {
  switch (kind) {
    case "path":
      return namedFile(token) ?? "a file path";
    case "url":
      return "a link";
    case "hash":
      return "a commit hash";
    default:
      return "an identifier";
  }
}

/**
 * "the narrate file" beats "a file path" — the listener is looking at the screen and wants to know
 * *which* file. Only when the name reads as words, though: a stem with a digit in it is as
 * unspeakable as the path was.
 */
const ARTICLES = new Set(["a", "an", "the"]);

function bareWord(token: string): string {
  return token.replace(LEADING_PUNCTUATION, "").replace(TRAILING_PUNCTUATION, "").toLowerCase();
}

/**
 * "at commit 21d1608" must not become "at commit a commit hash". When the word in front of a
 * substitution already names the thing, the lead-in goes — and if the sentence already had an
 * article for it, the phrase drops its own rather than stranding the sentence's.
 *
 * Mutates the lead-in out of `parts`; returns the phrase to put in its place.
 */
function swallowRedundantLeadIn(parts: string[], at: number, phrase: string): string {
  const words = phrase.toLowerCase().split(" ");
  const previous = at - 2;
  if (previous < 0 || !words.includes(bareWord(parts[previous] ?? ""))) return phrase;
  parts[previous] = "";
  parts[previous + 1] = "";
  const article = previous - 2;
  const sentenceHasTheArticle =
    article >= 0 && ARTICLES.has(words[0] ?? "") && ARTICLES.has(bareWord(parts[article] ?? ""));
  return sentenceHasTheArticle ? phrase.slice((words[0] ?? "").length + 1) : phrase;
}

/** Where a Cue's node sits in the source, so Cues read in the order the eye meets them. */
function positionIn(raw: string, cue: Cue): number {
  const at = raw.indexOf(cue.source);
  return at < 0 ? raw.length : at;
}

function namedFile(token: string): string | null {
  const base = token.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const stem = base.slice(0, dot).toLowerCase();
  if (!/^[a-z][a-z]*(?:[-_][a-z]+)*$/.test(stem)) return null;
  return `the ${stem.replace(/[-_]/g, " ")} file`;
}

export function speakInline(raw: string): { text: string; cues: Cue[] } {
  const cues: Cue[] = [];
  let text = raw;

  // A badge is an image wrapped in a link, so it has to be recognised before either half is.
  text = text.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, (match) => {
    cues.push(drop("image", match));
    return " ";
  });

  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, (match) => {
    cues.push(drop("image", match));
    return " ";
  });

  text = text.replace(
    /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g,
    (match, label: string, href: string) => {
      const say = label.replace(/[*_`~]/g, "").trim();
      // A link with no words of its own has nothing that could stand in for it, so it is
      // decoration: recorded, and silent. A reference that says nothing would be a silent skip.
      cues.push(
        say
          ? { node: classifyUnspeakable(href) ?? "url", fate: "reference", say, source: href }
          : drop("url", match),
      );
      return say || " ";
    },
  );

  text = text.replace(/`+([^`]+)`+/g, (_match, code: string) => {
    const token = code.trim().replace(/\(\s*\)$/, "");
    const kind = classifyUnspeakable(token);
    if (!kind) return token;
    const cue = reference(kind, token);
    cues.push(cue);
    return cue.say;
  });

  text = text.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, (_match, href: string) => {
    const cue = reference("url", href);
    cues.push(cue);
    return cue.say;
  });

  const parts = text.split(/(\s+)/);
  for (let at = 0; at < parts.length; at++) {
    const token = parts[at] ?? "";
    const lead = LEADING_PUNCTUATION.exec(token)?.[0] ?? "";
    const trail = TRAILING_PUNCTUATION.exec(token.slice(lead.length))?.[0] ?? "";
    const core = token.slice(lead.length, token.length - trail.length);
    const kind = core ? classifyUnspeakable(core) : null;
    if (!kind) continue;
    const cue = reference(kind, core);
    cues.push(cue);
    parts[at] = `${lead}${swallowRedundantLeadIn(parts, at, cue.say)}${trail}`;
  }
  text = parts.join("");

  text = text.replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, (match) => {
    cues.push(drop("emoji", match));
    return " ";
  });

  text = text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^\w*])\*([^*]+)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/(^|[^\w_])_([^_]+)_(?=[^\w_]|$)/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  // Substitution order is badges, then links, then code, then bare tokens — nothing like the order
  // they appear in. The Player shows Cues against the live position, so they have to read in source
  // order. Two occurrences of the same token tie, and keep the order they were found in.
  return { text, cues: cues.toSorted((a, b) => positionIn(raw, a) - positionIn(raw, b)) };
}
