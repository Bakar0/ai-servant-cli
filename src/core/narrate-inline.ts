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

  text = text
    .split(/(\s+)/)
    .map((token) => {
      const lead = LEADING_PUNCTUATION.exec(token)?.[0] ?? "";
      const trail = TRAILING_PUNCTUATION.exec(token.slice(lead.length))?.[0] ?? "";
      const core = token.slice(lead.length, token.length - trail.length);
      const kind = core ? classifyUnspeakable(core) : null;
      if (!kind) return token;
      const cue = reference(kind, core);
      cues.push(cue);
      return `${lead}${cue.say}${trail}`;
    })
    .join("");

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

  return { text, cues };
}
