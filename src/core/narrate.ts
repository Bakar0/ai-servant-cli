// The text half of a Narration: a Turn's markdown in, Ear-copy Segments out. It knows nothing
// about transcripts — the reader is a caller — so narrating a file or stdin later is an entry
// point rather than a rewrite (workspace ADR 0001).

import { createSentenceCutter, earCopyPrompt } from "./narrate-ear-copy.ts";
import { assertSpeakable, isConversationalOffer, NarrationLeakError } from "./narrate-leak.ts";
import type { Leak } from "./narrate-leak.ts";
import { segmentMarkdown } from "./narrate-rules.ts";

/** A node that must never be read out character-by-character. */
export type UnspeakableKind =
  | "table"
  | "code"
  | "diagram"
  | "path"
  | "url"
  | "hash"
  | "identifier"
  | "emoji"
  | "image"
  | "rule";

/**
 * The record that an Unspeakable node was passed over, and what stands in its place.
 *
 * `say` is the phrase that occupies the node's slot in the Ear-copy — the description for a table,
 * the noun phrase for a path, the link's own words for a link. It is empty only for decoration
 * (an emoji, a rule, a badge), which has nothing to stand in for. Everything else must speak:
 * a skip the listener is never told about defeats the point of a Narration.
 */
export interface Cue {
  node: UnspeakableKind;
  fate: "describe" | "reference" | "drop";
  say: string;
  source: string;
}

/**
 * `beat` is a heading. It carries the pause the Player puts before it — the pause is the kind, not
 * a duration, because this module owns no timing. `description` is a node the model writes a
 * sentence about. `prose` is everything spoken more or less as written.
 */
export type BlockKind = "beat" | "prose" | "description";

/** The rules layer's output: one markdown block, classified, with everything unspeakable resolved. */
export interface Block {
  index: number;
  kind: BlockKind;
  /**
   * What reaches the model. Safe text for prose; for a `description` this is the Unspeakable node
   * itself, because the model cannot describe what it has not seen — which is precisely why the
   * leak validator exists on the way out.
   */
  text: string;
  /** Spoken when there is no model in the path. For a `description`, the Cue's own words. */
  fallback: string;
  cues: readonly Cue[];
  source: string;
}

/** One independently synthesized, independently cached piece of Ear-copy. */
export interface Segment {
  index: number;
  kind: BlockKind;
  text: string;
  cues: readonly Cue[];
  source: string;
  /** Set when the rewrite was cut short because it leaked. `text` is only what passed the gate. */
  leaked?: readonly Leak[];
}

/**
 * Three events, because they answer three different needs. A `sentence` is the smallest thing
 * worth synthesizing, and emitting it mid-block is what buys the first spoken word at ~1.5s
 * instead of the ~4s a whole-block rewrite costs. A `segment` is the unit the Player caches and
 * seeks over. A `leak` is the loud part of a hard failure.
 */
export type NarrationEvent =
  | { type: "sentence"; segment: number; text: string }
  | { type: "segment"; segment: Segment }
  | { type: "leak"; segment: number; leaks: readonly Leak[] };

/** Streams one prompt's completion as text deltas, in order. */
export interface EarCopyModel {
  stream(prompt: { system: string; user: string }): AsyncIterable<string>;
}

export interface NarrateOptions {
  /** Absent means offline: blocks are spoken as the rules left them, descriptions as their Cue. */
  model?: EarCopyModel;
}

/**
 * Markdown to Ear-copy. Every sentence passes the leak validator before it is yielded, so nothing
 * unspeakable is ever handed downstream.
 *
 * A leak fails the Segment, hard: the rewrite is abandoned where it leaked, a `leak` event fires,
 * and the Segment speaks its Cue instead of the model's words. It does not take the rest of the
 * Turn down with it — the handoff asks for the Segment to fail, not the Narration.
 */
export async function* narrateMarkdown(
  markdown: string,
  options: NarrateOptions = {},
): AsyncGenerator<NarrationEvent> {
  let heading = "";

  for (const block of segmentMarkdown(markdown)) {
    if (block.kind === "beat") heading = block.fallback;

    const spoken: string[] = [];
    let leaked: readonly Leak[] | undefined;

    for await (const sentence of rewrite(block, heading, options.model)) {
      if (isConversationalOffer(sentence)) continue;
      try {
        assertSpeakable(sentence, `segment ${block.index}`);
      } catch (error) {
        if (!(error instanceof NarrationLeakError)) throw error;
        leaked = error.leaks;
        break;
      }
      spoken.push(sentence);
      yield { type: "sentence", segment: block.index, text: sentence };
    }

    if (leaked) yield { type: "leak", segment: block.index, leaks: leaked };

    // Nothing survived — a leak, an empty answer, an answer that was only an offer to help. The
    // Cue still has to be heard, or the listener never learns the node was on screen at all.
    if (spoken.length === 0 && block.fallback.trim()) {
      spoken.push(block.fallback);
      yield { type: "sentence", segment: block.index, text: block.fallback };
    }

    yield {
      type: "segment",
      segment: {
        index: block.index,
        kind: block.kind,
        text: spoken.join(" "),
        cues: block.cues,
        source: block.source,
        ...(leaked ? { leaked } : {}),
      },
    };
  }
}

/** Every Segment of a finished Narration. A Segment stopped by a leak carries `leaked`. */
export async function narrateToSegments(
  markdown: string,
  options: NarrateOptions = {},
): Promise<Segment[]> {
  const segments: Segment[] = [];
  for await (const event of narrateMarkdown(markdown, options)) {
    if (event.type === "segment") segments.push(event.segment);
  }
  return segments;
}

/**
 * A heading never goes to the model: it is already ear-shaped, and spending a round trip on four
 * words is exactly the latency the pipeline cannot afford at the start of a Turn.
 */
async function* rewrite(
  block: Block,
  heading: string,
  model: EarCopyModel | undefined,
): AsyncGenerator<string> {
  const cutter = createSentenceCutter();
  if (block.kind === "beat" || !model) {
    yield* [...cutter.push(block.fallback), ...cutter.flush()];
    return;
  }
  for await (const delta of model.stream(earCopyPrompt(block, heading))) {
    yield* cutter.push(delta);
  }
  yield* cutter.flush();
}
