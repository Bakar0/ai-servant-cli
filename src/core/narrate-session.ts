import { stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectsRoot, encodeProjectDir } from "./claude-session.ts";
import { workspacesRoot } from "./paths.ts";
import { type Turn, followTurn, readTurns } from "./narrate-turn.ts";
import { type NarrateOptions, type NarrationEvent, narrateMarkdown } from "./narrate.ts";

// Which transcript, and how a Turn that is still being written becomes one continuous stream of
// Segments. Everything transcript-shaped that is not "what is a Turn" (that is `narrate-turn.ts`)
// and not "what does a Turn sound like" (that is the pipeline).

export interface ResolvedSession {
  sessionId: string;
  jsonlPath: string;
}

/**
 * How many of a directory's sessions the picker reaches back over.
 *
 * The reply you want to hear again is nearly always from today or yesterday, and each session read
 * is a whole transcript parsed. Twenty is weeks of work in a busy directory and still opens the
 * picker instantly.
 */
export const PICKER_SESSION_LIMIT = 20;

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

/**
 * The project directories a picker should look in.
 *
 * A servant workspace is not one project directory. Every mounted repo worktree under `repos/` is
 * its own directory as far as Claude Code is concerned, so one workspace fans out into a dozen of
 * them and a picker scoped to the directory you are standing in cannot see the session in the tab
 * next door. Scoped to the workspace, it can.
 *
 * Matching is on the encoded prefix, because `encodeProjectDir` is lossy and there is nothing to
 * decode back. The cost of that is a sibling workspace whose name extends this one's — `foo-2`
 * alongside `foo` — coming along too. Its rows say which session they are, so it shows.
 */
export async function projectDirsToPickFrom(
  cwd: string,
  options: { anywhere?: boolean } = {},
): Promise<string[]> {
  const root = claudeProjectsRoot();
  const names: string[] = [];
  try {
    for await (const name of new Bun.Glob("*").scan({ cwd: root, onlyFiles: false, dot: true })) {
      names.push(name);
    }
  } catch {
    return [];
  }
  if (options.anywhere) return names.map((name) => join(root, name));

  const prefix = encodeProjectDir(workspaceRootOf(cwd) ?? cwd);
  return names
    .filter((name) => name === prefix || name.startsWith(`${prefix}-`))
    .map((name) => join(root, name));
}

/** The workspace a path is inside, if it is inside one. Everywhere else, a directory is itself. */
function workspaceRootOf(cwd: string): string | null {
  const root = workspacesRoot();
  if (!cwd.startsWith(`${root}/`)) return null;
  const name = cwd.slice(root.length + 1).split("/")[0];
  return name ? join(root, name) : null;
}

/**
 * Every Turn worth picking from, newest first — across the sessions of a whole workspace, not just
 * the newest session of the directory you happen to be standing in.
 *
 * Narrating defaults to the newest Turn of the newest session, which is right for "read me that
 * back". Picking is the other gesture: you remember a reply and not which session it was in, and a
 * picker that could only reach one session would be unable to find most of what you would ask it
 * for.
 */
export async function turnsToPickFrom(
  cwd: string,
  options: { limit?: number; anywhere?: boolean } = {},
): Promise<Turn[]> {
  const dirs = await projectDirsToPickFrom(cwd, options);
  const found: { path: string; mtimeMs: number }[] = [];
  for (const dir of dirs) {
    try {
      for await (const name of new Bun.Glob("*.jsonl").scan({ cwd: dir, onlyFiles: true })) {
        const path = join(dir, name);
        found.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      }
    } catch {
      // A directory that went away between the listing and now.
    }
  }
  // Capped by modification time before anything is parsed, so widening the scope costs a `stat` per
  // session and not a transcript read. There are hundreds of them on this machine.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const turns: Turn[] = [];
  for (const session of found.slice(0, options.limit ?? PICKER_SESSION_LIMIT)) {
    // Newest Turn first within each session, so the whole list reads newest-first without needing
    // timestamps that a transcript does not always carry.
    turns.push(...(await readTurns(session.path)).reverse());
  }
  return turns;
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
      highest = Math.max(highest, segmentOf(event));
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

/** Which Segment an event is about, whatever kind it is. */
function segmentOf(event: NarrationEvent): number {
  return event.type === "segment" ? event.segment.index : event.segment;
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
