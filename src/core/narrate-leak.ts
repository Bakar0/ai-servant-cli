import type { UnspeakableKind } from "./narrate.ts";

// What "unspeakable" actually looks like, and the two different jobs that shape it.
//
// The rules layer substitutes, so over-reaching there costs a noun phrase — it can afford to be
// greedy. The validator kills a Narration, so it only fires on text that is unambiguously
// unspeakable. Same vocabulary, two thresholds; keeping both in one module is what stops them
// drifting apart.

export interface Leak {
  kind: UnspeakableKind;
  text: string;
}

export class NarrationLeakError extends Error {
  constructor(
    readonly where: string,
    readonly leaks: readonly Leak[],
  ) {
    super(
      `${where}: Ear-copy leaked ${leaks.map((leak) => `${leak.kind} ${JSON.stringify(leak.text)}`).join(", ")}`,
    );
    this.name = "NarrationLeakError";
  }
}

/** Extensions common enough in a coding session that `name.ext` is a filename, not a sentence. */
const FILE_EXTENSIONS = new Set([
  "bash",
  "cfg",
  "cjs",
  "conf",
  "csv",
  "css",
  "db",
  "env",
  "go",
  "html",
  "ini",
  "java",
  "jpg",
  "js",
  "json",
  "jsx",
  "kt",
  "lock",
  "log",
  "md",
  "mdx",
  "mjs",
  "pdf",
  "png",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "sqlite",
  "svg",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

/**
 * Slash pairs a listener hears as words rather than as a location. Everything else with a slash in
 * it is a path as far as the rules are concerned — the failure mode of guessing wrong is one
 * clumsy noun phrase, and the failure mode of guessing wrong the other way is spelling a path out.
 */
const SPOKEN_SLASH_PAIRS = new Set([
  "and/or",
  "ci/cd",
  "either/or",
  "he/she",
  "his/her",
  "i/o",
  "in/out",
  "input/output",
  "km/h",
  "n/a",
  "on/off",
  "read/write",
  "s/he",
  "tcp/ip",
  "w/o",
  "yes/no",
]);

const URL = /^(?:https?:\/\/|www\.)\S+$/i;
const FENCE_MARKER = /(?:```|~~~)/;

/** Shared with the inline rules, which need the same punctuation edges but as positions. */
export const LEADING_PUNCTUATION = /^[([{"'“‘]+/;
export const TRAILING_PUNCTUATION = /[.,;:!?)\]}"'”’]+$/;
const HEX = /^[0-9a-f]{7,40}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{16,}$/;

function trimPunctuation(token: string): string {
  return token.replace(LEADING_PUNCTUATION, "").replace(TRAILING_PUNCTUATION, "");
}

function hasFileExtension(token: string): boolean {
  const last = token.slice(token.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return false;
  return FILE_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

function isPath(token: string, greedy: boolean): boolean {
  if (/^(?:\.{1,2}\/|~\/|\/)/.test(token) && token.length > 1) return true;
  if (hasFileExtension(token)) return true;
  if (!token.includes("/")) return false;
  if (SPOKEN_SLASH_PAIRS.has(token.toLowerCase())) return false;
  if (/^\d+(?:\/\d+)+$/.test(token)) return false;
  if ((token.match(/\//g) ?? []).length >= 2) return true;
  return greedy && /^[^\s/]+\/[^\s/]+$/.test(token);
}

/** A hash needs both a hex letter and a digit — otherwise "defaced" and "1234567" both qualify. */
function isHash(token: string): boolean {
  const lower = token.toLowerCase();
  return HEX.test(lower) && /[a-f]/.test(lower) && /\d/.test(lower);
}

function isLongIdentifier(token: string): boolean {
  return IDENTIFIER.test(token) && /\d/.test(token) && /[A-Za-z]/.test(token);
}

function classify(raw: string, greedy: boolean): UnspeakableKind | null {
  if (FENCE_MARKER.test(raw)) return "code";
  const token = trimPunctuation(raw);
  if (!token) return null;
  if (URL.test(token)) return "url";
  if (isPath(token, greedy)) return "path";
  if (isHash(token)) return "hash";
  if (isLongIdentifier(token)) return "identifier";
  return null;
}

/** The rules layer's reading of a single token: greedy, because it substitutes rather than fails. */
export function classifyUnspeakable(token: string): UnspeakableKind | null {
  return classify(token, true);
}

/** Everything in this text that must never be spoken. Empty means the text is safe to synthesize. */
export function findLeaks(text: string): Leak[] {
  const leaks: Leak[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    const kind = classify(raw, false);
    if (kind) leaks.push({ kind, text: trimPunctuation(raw) || raw });
  }
  return leaks;
}

/** Hard failure, not a warning: a Segment that cannot be made safe is not spoken at all. */
export function assertSpeakable(text: string, where: string): void {
  const leaks = findLeaks(text);
  if (leaks.length > 0) throw new NarrationLeakError(where, leaks);
}

/**
 * A Narration describes; it does not offer. `gpt-5-mini` closed a rewrite with "If you want, I
 * can: (a)… (b)…" — it heard a narration job as a conversation. Sentences shaped like that are
 * dropped wherever they appear, since the shape identifies them without needing to be the tail.
 */
const OFFERS: readonly RegExp[] = [
  /\bif you (?:want|wish|'d like|would like)\b[^.?!]*\bi(?:'ll| can| could| will)\b/i,
  /\bi(?:'ll| can| could| will)\b[^.?!]*\bif you (?:want|wish|'d like|would like)\b/i,
  /\blet me know if\b/i,
  /\b(?:would|do) you (?:want|like) me to\b/i,
  /\bwant me to\b/i,
  /\bshall i\b/i,
  /\bjust say the word\b/i,
  /\bi (?:can|could)(?: also)?\s*:/i,
  /\(a\)[\s\S]*\(b\)/,
];

export function isConversationalOffer(sentence: string): boolean {
  return OFFERS.some((offer) => offer.test(sentence));
}
