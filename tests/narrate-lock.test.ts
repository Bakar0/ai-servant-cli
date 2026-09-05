// One Player at a time, and a lock that a crash does not turn into a permanent one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePlayerLock, playerLockHolder } from "../src/core/narrate-lock.ts";
import { cacheDir, narrateLockPath, setRootOverride } from "../src/core/paths.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "servant-narrate-lock-"));
  setRootOverride(root);
});

afterEach(async () => {
  setRootOverride(null);
  await rm(root, { recursive: true, force: true });
});

const nobodyIsAlive = { alive: () => false };
const everybodyIsAlive = { alive: () => true };

describe("the player lock", () => {
  test("the first Player gets it", async () => {
    expect(await acquirePlayerLock({ pid: 111 })).not.toBeNull();
    expect(await playerLockHolder(everybodyIsAlive)).toBe(111);
  });

  test("the second is refused while the first is alive", async () => {
    await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    expect(await acquirePlayerLock({ pid: 222, ...everybodyIsAlive })).toBeNull();
  });

  test("releasing hands it on", async () => {
    const first = await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    await first?.release();
    expect(await acquirePlayerLock({ pid: 222, ...everybodyIsAlive })).not.toBeNull();
  });

  test("a lock whose holder is gone is not a lock", async () => {
    await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    expect(await acquirePlayerLock({ pid: 222, ...nobodyIsAlive })).not.toBeNull();
  });

  test("a half-written lockfile is not a lock either", async () => {
    await mkdir(cacheDir(), { recursive: true });
    await Bun.write(narrateLockPath(), "{ not json");
    expect(await playerLockHolder(everybodyIsAlive)).toBeNull();
    expect(await acquirePlayerLock({ pid: 222, ...everybodyIsAlive })).not.toBeNull();
  });

  test("a stolen lock is not deleted by the Player it was stolen from", async () => {
    const stale = await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    await acquirePlayerLock({ pid: 222, ...nobodyIsAlive });
    await stale?.release();
    expect(await playerLockHolder(everybodyIsAlive)).toBe(222);
    expect(existsSync(narrateLockPath())).toBe(true);
  });

  test("nobody holding it reads as free", async () => {
    expect(await playerLockHolder()).toBeNull();
  });
});
