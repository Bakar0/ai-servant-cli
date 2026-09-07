// One Player at a time, and a lock that a crash does not turn into a permanent one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquirePlayerLock,
  endPlayerLockHolder,
  playerLockDetail,
  playerLockHolder,
} from "../src/core/narrate-lock.ts";
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

  test("a lockfile left half-written by a crash is not a lock either", async () => {
    await mkdir(cacheDir(), { recursive: true });
    await Bun.write(narrateLockPath(), "{ not json");
    const old = new Date(Date.now() - 60_000);
    await utimes(narrateLockPath(), old, old);
    expect(await playerLockHolder(everybodyIsAlive)).toBeNull();
    expect(await acquirePlayerLock({ pid: 222, ...everybodyIsAlive })).not.toBeNull();
  });

  test("a lockfile being written this instant is somebody, not rubbish", async () => {
    await mkdir(cacheDir(), { recursive: true });
    // The same bytes as the test above. What separates them is that this one is one tick old, so it
    // is a Player that has created its file and not yet said who it is.
    await Bun.write(narrateLockPath(), "");
    expect(await acquirePlayerLock({ pid: 222, ...everybodyIsAlive })).toBeNull();
  });

  test("a stolen lock is not deleted by the Player it was stolen from", async () => {
    const stale = await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    await acquirePlayerLock({ pid: 222, ...nobodyIsAlive });
    await stale?.release();
    expect(await playerLockHolder(everybodyIsAlive)).toBe(222);
    expect(existsSync(narrateLockPath())).toBe(true);
  });

  test("two Players starting at once, only one wins", async () => {
    // The reason the claim is an exclusive create and not a read-then-write: both of these check
    // and both of these write, inside the same tick.
    const [first, second] = await Promise.all([
      acquirePlayerLock({ pid: 111, ...everybodyIsAlive }),
      acquirePlayerLock({ pid: 222, ...everybodyIsAlive }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  test("nobody holding it reads as free", async () => {
    expect(await playerLockHolder()).toBeNull();
  });
});

describe("who is holding it", () => {
  test("says what the holder is, so a pid is a way back to the tab", async () => {
    await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    const held = await playerLockDetail({
      ...everybodyIsAlive,
      describe: () => "servant narrate --pick",
    });
    expect(held).toMatchObject({ pid: 111, command: "servant narrate --pick" });
    expect(held?.since).toBeGreaterThan(0);
  });

  test("a system that will not say is not an error, only a quieter message", async () => {
    await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    const held = await playerLockDetail({ ...everybodyIsAlive, describe: () => "" });
    expect(held).toMatchObject({ pid: 111, command: "" });
  });

  test("nobody holding it has no detail either", async () => {
    expect(await playerLockDetail()).toBeNull();
  });
});

describe("taking the player from a Player that is still running", () => {
  test("asks the holder to stop, rather than shooting it", async () => {
    await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    const signalled: number[] = [];
    await endPlayerLockHolder({
      ...everybodyIsAlive,
      signal: (pid) => signalled.push(pid),
      wait: async () => {},
    });
    // A Player asked to stop kills its sox, releases the lock and puts the terminal back. None of
    // that happens to a process that is shot.
    expect(signalled).toEqual([111]);
  });

  test("waits for the holder to actually let go", async () => {
    await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    let alive = true;
    const ended = await endPlayerLockHolder({
      alive: () => alive,
      signal: () => {},
      wait: async () => {
        alive = false;
      },
    });
    expect(ended).toBe(true);
  });

  test("a holder that will not go is reported rather than pretended about", async () => {
    await acquirePlayerLock({ pid: 111, ...everybodyIsAlive });
    expect(
      await endPlayerLockHolder({ ...everybodyIsAlive, signal: () => {}, wait: async () => {} }),
    ).toBe(false);
  });

  test("nothing to end is not a failure", async () => {
    expect(await endPlayerLockHolder()).toBe(true);
  });
});
