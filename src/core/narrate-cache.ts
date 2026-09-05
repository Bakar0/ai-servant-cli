import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { narrateCacheDir, narrateTurnDir } from "./paths.ts";

// Synthesized Segments at rest. Two jobs: never speak audio that no longer matches its Ear-copy,
// and never grow without end.
//
// The key is the reason the first one holds. A Turn's uuid alone would be the obvious key and it is
// the trap: the rewrite prompt is going to be tuned constantly for as long as this feature is
// interesting, and a uuid-keyed cache answers every tuning run with yesterday's voice — an hour
// spent wondering why a prompt change did nothing. So the Ear-copy itself is in the key, along with
// everything else that decides how a sentence sounds.
//
// The consequence, taken deliberately: a replayed Turn still pays for the rewrite, because the key
// cannot be computed until the Ear-copy exists. It saves the synthesis hop, which is the larger and
// slower of the two. Skipping the rewrite as well needs the Turn's Ear-copy kept alongside its
// audio, and that is Pre-warm's problem, not this one.
//
// A file is a *sentence*, not a Segment, which is a departure from the ticket's letter. The Segment
// stays the unit the Transport seeks over — a Segment's audio is its sentence files, in order — but
// it cannot be the unit on disk, because a Segment's key is not known until the Segment has closed
// and by then every sentence in it has already been synthesized. Keyed by sentence, the second
// listen to a Turn makes no synthesis calls at all, which is the entire reason for a cache. The key
// is unchanged: Turn in the path, Ear-copy and voice and engine in the name.

/** A week. Long enough to re-listen to yesterday's session, short enough that nothing accumulates. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 500 MB — roughly three hours of speech, and about a day of heavy use. */
export const CACHE_MAX_BYTES = 500 * 1024 * 1024;

const SEGMENT_FILE = /^\d+-\d+-[0-9a-z]+\.pcm$/;

/**
 * What a Segment's audio depends on: the words, who says them, and what does the saying. Anything
 * that changes the sound has to change this string, or the cache lies.
 */
export function earCopyDigest(text: string, voice: string, engine: string): string {
  return Bun.hash(`${engine} ${voice} ${text}`).toString(36);
}

export interface NarrationCache {
  path(segment: number, sentence: number, digest: string): string;
  read(segment: number, sentence: number, digest: string): Promise<Uint8Array | null>;
  write(segment: number, sentence: number, digest: string, pcm: Uint8Array): Promise<void>;
}

/** One Turn's Segments. The Turn is the directory; the Ear-copy and voice are the filename. */
export function openNarrationCache(sessionId: string, turnUuid: string): NarrationCache {
  const dir = narrateTurnDir(sessionId, turnUuid);
  const path = (segment: number, sentence: number, digest: string) =>
    join(dir, `${segment}-${sentence}-${digest}.pcm`);
  return {
    path,
    async read(segment, sentence, digest) {
      const file = Bun.file(path(segment, sentence, digest));
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    },
    async write(segment, sentence, digest, pcm) {
      await mkdir(dir, { recursive: true });
      await Bun.write(path(segment, sentence, digest), pcm);
    },
  };
}

export interface SweepResult {
  removed: number;
  freedBytes: number;
  keptBytes: number;
}

export interface SweepOptions {
  maxAgeMs?: number;
  maxBytes?: number;
  now?: number;
}

/**
 * Run at launch, before a word is spoken: age first, then size, oldest-first. Whichever bites first
 * is the one that decides, which is what "or, whichever bites first" means when both are true.
 *
 * Only files this module wrote are considered — anything else in there was put there by a person,
 * and a cache sweep is not a licence to delete somebody's notes.
 */
export async function sweepNarrationCache(options: SweepOptions = {}): Promise<SweepResult> {
  const maxAgeMs = options.maxAgeMs ?? CACHE_MAX_AGE_MS;
  const maxBytes = options.maxBytes ?? CACHE_MAX_BYTES;
  const now = options.now ?? Date.now();

  const files = await listSegments();
  const doomed: CachedSegment[] = [];
  const kept: CachedSegment[] = [];
  for (const file of files) {
    (now - file.mtimeMs > maxAgeMs ? doomed : kept).push(file);
  }

  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let keptBytes = kept.reduce((sum, file) => sum + file.size, 0);
  while (keptBytes > maxBytes && kept.length > 0) {
    const oldest = kept.shift();
    if (!oldest) break;
    keptBytes -= oldest.size;
    doomed.push(oldest);
  }

  let freedBytes = 0;
  for (const file of doomed) {
    await rm(file.path, { force: true });
    freedBytes += file.size;
  }
  if (doomed.length > 0) await pruneEmptyDirs();

  return { removed: doomed.length, freedBytes, keptBytes };
}

interface CachedSegment {
  path: string;
  size: number;
  mtimeMs: number;
}

async function listSegments(): Promise<CachedSegment[]> {
  const root = narrateCacheDir();
  const found: CachedSegment[] = [];
  // `<session>/<turn>/<segment>-<sentence>-<digest>.pcm` — the shape is the filter, so a stray file
  // at any other depth is invisible to the sweep rather than being judged by its name alone.
  const glob = new Bun.Glob("*/*/*.pcm");
  try {
    for await (const relative of glob.scan({ cwd: root, onlyFiles: true })) {
      const name = relative.split("/").pop() ?? "";
      if (!SEGMENT_FILE.test(name)) continue;
      const path = join(root, relative);
      const info = await stat(path);
      found.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    }
  } catch {
    // No cache directory yet: nothing to sweep, and saying so is not an error.
  }
  return found;
}

/** Turn and session directories the sweep emptied. Never the cache root itself, and never above it. */
async function pruneEmptyDirs(): Promise<void> {
  const root = narrateCacheDir();
  for (const session of await entries(root)) {
    const sessionDir = join(root, session);
    for (const turn of await entries(sessionDir)) {
      const turnDir = join(sessionDir, turn);
      if ((await entries(turnDir)).length === 0)
        await rm(turnDir, { recursive: true, force: true });
    }
    if ((await entries(sessionDir)).length === 0) {
      await rm(sessionDir, { recursive: true, force: true });
    }
  }
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
