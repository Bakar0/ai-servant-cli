// The Ear-copy cache, on a throwaway root. What is tested here is the key and the sweep, because
// those are the two ways a cache goes wrong quietly: serving audio that no longer matches the
// Ear-copy, and growing without end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_MAX_AGE_MS,
  openNarrationCache,
  earCopyDigest,
  sweepNarrationCache,
} from "../src/core/narrate-cache.ts";
import { narrateCacheDir, narrateTurnDir, setRootOverride } from "../src/core/paths.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "servant-narrate-cache-"));
  setRootOverride(root);
});

afterEach(async () => {
  setRootOverride(null);
  await rm(root, { recursive: true, force: true });
});

const SESSION = "11111111-2222-3333-4444-555555555555";
const TURN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function pcm(byte: number, length = 8): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

describe("the cache key", () => {
  test("re-narrating the same Ear-copy in the same voice hits", async () => {
    const cache = openNarrationCache(SESSION, TURN);
    const key = earCopyDigest("The rewrite is streamed.", "alloy", "gpt-4o-mini-tts");
    await cache.write(0, 0, key, pcm(7));
    expect(await cache.read(0, 0, key)).toEqual(pcm(7));
  });

  test("a tuned rewrite prompt misses, because the Ear-copy changed", async () => {
    const cache = openNarrationCache(SESSION, TURN);
    await cache.write(0, 0, earCopyDigest("Old words.", "alloy", "gpt-4o-mini-tts"), pcm(7));
    const tuned = earCopyDigest("New words.", "alloy", "gpt-4o-mini-tts");
    expect(await cache.read(0, 0, tuned)).toBeNull();
  });

  test("a different voice misses", () => {
    const same = "The rewrite is streamed.";
    expect(earCopyDigest(same, "alloy", "gpt-4o-mini-tts")).not.toBe(
      earCopyDigest(same, "marin", "gpt-4o-mini-tts"),
    );
  });

  test("a different engine misses", () => {
    const same = "The rewrite is streamed.";
    expect(earCopyDigest(same, "alloy", "gpt-4o-mini-tts")).not.toBe(
      earCopyDigest(same, "alloy", "say"),
    );
  });

  test("a different Turn with identical Ear-copy is a different file", async () => {
    const key = earCopyDigest("Identical.", "alloy", "gpt-4o-mini-tts");
    expect(openNarrationCache(SESSION, TURN).path(0, 0, key)).not.toBe(
      openNarrationCache(SESSION, "ffffffff-1111-2222-3333-444444444444").path(0, 0, key),
    );
  });

  test("a missing file reads as a miss rather than throwing", async () => {
    const cache = openNarrationCache(SESSION, TURN);
    expect(await cache.read(3, 0, "nothing")).toBeNull();
  });
});

describe("the sweep", () => {
  async function age(path: string, ms: number): Promise<void> {
    const when = new Date(Date.now() - ms);
    await utimes(path, when, when);
  }

  test("takes what is older than a week", async () => {
    const cache = openNarrationCache(SESSION, TURN);
    const stale = cache.path(0, 0, "stale");
    const fresh = cache.path(1, 0, "fresh");
    await cache.write(0, 0, "stale", pcm(1));
    await cache.write(1, 0, "fresh", pcm(1));
    await age(stale, CACHE_MAX_AGE_MS + 60_000);

    const swept = await sweepNarrationCache();
    expect(swept.removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("takes the oldest first when the total is over budget", async () => {
    const cache = openNarrationCache(SESSION, TURN);
    await cache.write(0, 0, "oldest", pcm(1, 400));
    await cache.write(1, 0, "newest", pcm(1, 400));
    await age(cache.path(0, 0, "oldest"), 60_000);

    const swept = await sweepNarrationCache({ maxBytes: 500 });
    expect(swept.removed).toBe(1);
    expect(existsSync(cache.path(0, 0, "oldest"))).toBe(false);
    expect(existsSync(cache.path(1, 0, "newest"))).toBe(true);
  });

  test("leaves the cache alone when it is inside both limits", async () => {
    const cache = openNarrationCache(SESSION, TURN);
    await cache.write(0, 0, "kept", pcm(1));
    expect((await sweepNarrationCache()).removed).toBe(0);
    expect(existsSync(cache.path(0, 0, "kept"))).toBe(true);
  });

  test("clears out the Turn directories it emptied", async () => {
    const cache = openNarrationCache(SESSION, TURN);
    await cache.write(0, 0, "stale", pcm(1));
    await age(cache.path(0, 0, "stale"), CACHE_MAX_AGE_MS + 60_000);
    await sweepNarrationCache();
    expect(existsSync(narrateTurnDir(SESSION, TURN))).toBe(false);
  });

  test("a cache that was never written is not an error", async () => {
    expect(await sweepNarrationCache()).toMatchObject({ removed: 0, keptBytes: 0 });
  });

  test("ignores anything in there that is not a Segment", async () => {
    await mkdir(narrateTurnDir(SESSION, TURN), { recursive: true });
    const stray = join(narrateTurnDir(SESSION, TURN), "notes.txt");
    await Bun.write(stray, "left by hand");
    await utimes(stray, new Date(0), new Date(0));
    expect((await sweepNarrationCache()).removed).toBe(0);
    expect(existsSync(stray)).toBe(true);
  });

  test("does not reach outside its own directory", async () => {
    const neighbour = join(narrateCacheDir(), "..", "voice");
    await mkdir(neighbour, { recursive: true });
    await sweepNarrationCache();
    expect(existsSync(neighbour)).toBe(true);
  });
});
