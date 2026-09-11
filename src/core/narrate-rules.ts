import { speakInline } from "./narrate-inline.ts";
import type { Block, BlockKind, Cue } from "./narrate.ts";

// The block rules: markdown in, blocks out, with every Unspeakable node already resolved. It is
// deliberately hand-rolled — the repo takes no markdown dependency, and the one renderer it does
// have goes straight to HTML without exposing the node classification this needs.
//
// This is the half of the guarantee that decides what *reaches* the model. The other half — the
// leak validator — checks what comes back, and the two are not redundant: a model told not to
// read a path aloud will still occasionally write one into its own description of a code block.

const FENCE = /^\s{0,3}(?:```+|~~~+)\s*([^\s`]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const DIAGRAM_LINE = /[─-╿]|\+[-=]{2,}|-->|<--/;
const INDENTED = /^(?: {4}|\t)/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/** Block-level skips are cued as whole sentences; inline ones are cued as noun phrases. */
const DESCRIPTION_CUE: Record<"code" | "table" | "diagram", string> = {
  code: "There's a code block here.",
  table: "There's a table here.",
  diagram: "There's a diagram here.",
};

type Draft = Omit<Block, "index">;

export function segmentMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const at = (index: number): string => lines[index] ?? "";
  const blocks: Block[] = [];
  let pending: Cue[] = [];

  const push = (draft: Draft) => {
    if (!draft.text.trim()) {
      pending = [...pending, ...draft.cues];
      return;
    }
    blocks.push({ ...draft, index: blocks.length, cues: [...pending, ...draft.cues] });
    pending = [];
  };

  const describe = (node: keyof typeof DESCRIPTION_CUE, body: string, raw: string[]) => {
    const say = DESCRIPTION_CUE[node];
    const source = raw.join("\n");
    push({
      kind: "description",
      text: body || say,
      fallback: say,
      cues: [{ node, fate: "describe", say, source }],
      source,
    });
  };

  const spoken = (kind: BlockKind, raw: string[], text: string, fallback?: string) => {
    const inline = speakInline(text);
    push({
      kind,
      text: inline.text,
      fallback: fallback ?? inline.text,
      cues: inline.cues,
      source: raw.join("\n"),
    });
  };

  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const start = i;
      i++;
      while (i < lines.length && !FENCE.test(at(i))) i++;
      const body = lines.slice(start + 1, i).join("\n");
      if (i < lines.length) i++;
      describe(fence[1] === "mermaid" ? "diagram" : "code", body, lines.slice(start, i));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      spoken("beat", [line], heading[2] ?? "");
      i++;
      continue;
    }

    if (RULE.test(line)) {
      pending.push({ node: "rule", fate: "drop", say: "", source: line.trim() });
      i++;
      continue;
    }

    if (line.includes("|") && TABLE_DELIMITER.test(at(i + 1))) {
      const start = i;
      while (i < lines.length && at(i).includes("|")) i++;
      const raw = lines.slice(start, i);
      describe("table", raw.join("\n"), raw);
      continue;
    }

    if (DIAGRAM_LINE.test(line) && DIAGRAM_LINE.test(at(i + 1))) {
      const start = i;
      while (i < lines.length && DIAGRAM_LINE.test(at(i))) i++;
      const raw = lines.slice(start, i);
      describe("diagram", raw.join("\n"), raw);
      continue;
    }

    if (INDENTED.test(line) && !at(i - 1).trim()) {
      const start = i;
      while (i < lines.length && (INDENTED.test(at(i)) || !at(i).trim())) i++;
      const raw = lines.slice(start, i);
      describe("code", raw.join("\n").trimEnd(), raw);
      continue;
    }

    if (QUOTE.test(line)) {
      const start = i;
      while (i < lines.length && QUOTE.test(at(i))) i++;
      const raw = lines.slice(start, i);
      spoken("prose", raw, raw.map((quoted) => quoted.replace(QUOTE, "")).join(" "));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const start = i;
      const items: string[] = [];
      while (i < lines.length && at(i).trim()) {
        const item = LIST_ITEM.exec(at(i));
        if (item) items.push(item[2] ?? "");
        else if (items.length > 0) items[items.length - 1] += ` ${at(i).trim()}`;
        else break;
        i++;
      }
      const said = items.map((item) => speakInline(item));
      const texts = said.map((item) => item.text).filter(Boolean);
      push({
        kind: "prose",
        // The model sees the items as items; a fallback with no model has to read as sentences.
        text: texts.join("\n"),
        fallback: texts.map(asSentence).join(" "),
        cues: said.flatMap((item) => item.cues),
        source: lines.slice(start, i).join("\n"),
      });
      continue;
    }

    const start = i;
    while (i < lines.length && at(i).trim() && !startsBlock(at, i, start)) i++;
    const raw = lines.slice(start, i);
    spoken("prose", raw, raw.join(" "));
  }

  if (pending.length > 0 && blocks.length > 0) {
    const last = blocks[blocks.length - 1] as Block;
    blocks[blocks.length - 1] = { ...last, cues: [...last.cues, ...pending] };
  }
  return blocks;
}

/** A paragraph runs until a blank line or the first line that opens some other kind of block. */
function startsBlock(at: (index: number) => string, i: number, start: number): boolean {
  if (i === start) return false;
  const line = at(i);
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes("|") && TABLE_DELIMITER.test(at(i + 1)))
  );
}

function asSentence(text: string): string {
  return /[.!?…:]$/.test(text) ? text : `${text}.`;
}
