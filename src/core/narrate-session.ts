import { stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectsRoot, encodeProjectDir } from "./claude-session.ts";
import { type Turn, followTurn } from "./narrate-turn.ts";
import { type NarrateOptions, type NarrationEvent, narrateMarkdown } from "./narrate.ts";

// Which transcript, and how a Turn that is still being written becomes one continuous stream of
// Segments. Everything transcript-shaped that is not "what is a Turn" (that is `narrate-turn.ts`)
// and not "what does a Turn sound like" (that is the pipeline).

export interface ResolvedSession {
  sessionId: string;
  jsonlPath: string;
}

/**
 * The newest transcript for a directory, which is what "narrate what just happened" means when you
 * are sitting in the session that wrote it.
 *
 * The caller is expected to *say* what it found. A Player that narrates the wrong session sounds
 * exactly like a Player that narrates the right one — there is no visual mismatch to notice —
 * so the only defence is printing the id it locked onto.
 */
export async function newestSessionForCwd(cwd: string): Promise<ResolvedSession | null> {
  const dir = join(claudeProjectsRoot(), encodeProjectDir(cwd));
  let newest: { path: string; mtimeMs: number } | null = null;
  try {
    for await (const name of new Bun.Glob("*.jsonl").scan({ cwd: dir, onlyFiles: true })) {
      const path = join(dir, name);
      const info = await stat(path);
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
    }
  } catch {
    // No transcripts for this directory.
  }
  if (!newest) return null;
  return {
    sessionId:
      newest.path
        .split("/")
        .pop()
        ?.replace(/\.jsonl$/, "") ?? "",
    jsonlPath: newest.path,
  };
}

export interface TurnStreamOptions extends NarrateOptions {
  /** Keep narrating as the Turn is written. Default: whenever the Turn has not finished. */
  follow?: boolean;
  /** Injected by the suite; forwarded to the follower's poll. */
  wait?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * A Turn as one continuous stream of Segments, whether it is finished or still arriving.
 *
 * The pipeline takes a whole markdown string and numbers its blocks from zero, which is right for a
 * finished Turn and wrong for a growing one: the second batch of blocks would arrive as Segment 0
 * again and overwrite the first paragraph on the Player's screen and in its timeline. So each batch
 * is narrated on its own and its Segment numbers are shifted past everything already spoken. That
 * the batches are block-aligned is what makes this sound like nothing at all: a Segment is never
 * split across two of them.
 */
export async function* narrateTurnStream(
  jsonlPath: string,
  turn: Turn,
  options: TurnStreamOptions = {},
): AsyncGenerator<NarrationEvent> {
  const follow = options.follow ?? !turn.complete;
  let offset = 0;

  const speak = async function* (markdown: string): AsyncGenerator<NarrationEvent> {
    let highest = -1;
    for await (const event of narrateMarkdown(markdown, { model: options.model })) {
      const index = event.type === "segment" ? event.segment.index : event.segment;
      highest = Math.max(highest, index);
      yield shift(event, offset);
    }
    offset += highest + 1;
  };

  if (!follow) {
    yield* speak(turn.markdown);
    return;
  }
  for await (const markdown of followTurn(jsonlPath, turn.uuid, {
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    yield* speak(markdown);
  }
}

function shift(event: NarrationEvent, by: number): NarrationEvent {
  if (by === 0) return event;
  if (event.type === "segment") {
    return { type: "segment", segment: { ...event.segment, index: event.segment.index + by } };
  }
  if (event.type === "leak") {
    return { type: "leak", segment: event.segment + by, leaks: event.leaks };
  }
  return { type: "sentence", segment: event.segment + by, text: event.text };
}
