import { mkdir, rm } from "node:fs/promises";
import { cacheDir, narrateLockPath } from "./paths.ts";

// One Player at a time. Two means two voices in the room, talking over each other about different
// things — and neither of them is the one you can pause, because you cannot tell which is which.
//
// A lockfile with a pid in it, and a holder that is gone is not a lock. That last part is what
// makes this usable: a Player killed with `kill -9` leaves its file behind, and a lock that refused
// for ever after the first crash would be worse than no lock at all.

interface LockData {
  pid: number;
  since: number;
}

export interface PlayerLock {
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** Injected by the suite. The default asks the operating system. */
  alive?: (pid: number) => boolean;
  pid?: number;
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 asks "could I signal this?" without sending anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid holding the lock, or null when it is free. Used to say *who* rather than just "no". */
export async function playerLockHolder(options: AcquireOptions = {}): Promise<number | null> {
  const alive = options.alive ?? processAlive;
  const file = Bun.file(narrateLockPath());
  if (!(await file.exists())) return null;
  try {
    const data = (await file.json()) as LockData;
    if (typeof data.pid !== "number" || !alive(data.pid)) return null;
    return data.pid;
  } catch {
    // Unreadable is indistinguishable from a half-written file from a Player that died mid-write.
    return null;
  }
}

/** Null when somebody else is already speaking. The caller says so; it does not queue. */
export async function acquirePlayerLock(options: AcquireOptions = {}): Promise<PlayerLock | null> {
  const holder = await playerLockHolder(options);
  if (holder !== null) return null;
  const pid = options.pid ?? process.pid;
  await mkdir(cacheDir(), { recursive: true });
  await Bun.write(narrateLockPath(), `${JSON.stringify({ pid, since: Date.now() })}\n`);
  return {
    async release() {
      // Only if it is still ours: a stale lock we stole may since have been stolen from us, and
      // deleting the new holder's file would put two voices in the room by way of tidying up.
      const still: LockData | null = await Bun.file(narrateLockPath())
        .json()
        .then((data: unknown) => data as LockData)
        .catch(() => null);
      if (still?.pid !== pid) return;
      await rm(narrateLockPath(), { force: true });
    },
  };
}
