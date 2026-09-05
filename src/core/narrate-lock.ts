import { mkdir, open, rm, stat } from "node:fs/promises";
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

/**
 * How long an unreadable lockfile is given the benefit of the doubt.
 *
 * There are two ways to read a lockfile with no pid in it. It is a Player that crashed between
 * creating the file and writing itself into it, in which case it is rubbish and should be cleared;
 * or it is a Player doing exactly that, right now, in which case clearing it hands the room to two
 * voices. They are the same bytes, and only age tells them apart.
 */
const BEING_WRITTEN_MS = 5000;

export interface AcquireOptions {
  /** Injected by the suite. The default asks the operating system. */
  alive?: (pid: number) => boolean;
  pid?: number;
}

/**
 * Whether the lockfile in the way belongs to nobody, and may be cleared.
 *
 * A file that says whose it is answers for itself, whatever its age: a live pid holds it, a dead one
 * left it behind. Only a file that says nothing needs the clock, and then only to tell a crash from
 * a Player that is writing itself in as we look.
 */
async function isAbandoned(options: AcquireOptions): Promise<boolean> {
  const alive = options.alive ?? processAlive;
  const data: LockData | null = await Bun.file(narrateLockPath())
    .json()
    .then((parsed: unknown) => parsed as LockData)
    .catch(() => null);
  if (data && typeof data.pid === "number") return !alive(data.pid);
  const written = await stat(narrateLockPath())
    .then((info) => info.mtimeMs)
    .catch(() => 0);
  return Date.now() - written > BEING_WRITTEN_MS;
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

/**
 * Null when somebody else is already speaking. The caller says so; it does not queue.
 *
 * The claim is an exclusive create (`wx`), not a read-then-write. Two Players started in the same
 * second would both read "free" and both write, and the whole point of the lock is the case where
 * two of them start at once — a check that only catches the leisurely collision is not a lock.
 * A file whose holder is gone is cleared first, so a crash does not lock the Player out for good.
 */
export async function acquirePlayerLock(options: AcquireOptions = {}): Promise<PlayerLock | null> {
  const pid = options.pid ?? process.pid;
  await mkdir(cacheDir(), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(narrateLockPath(), "wx");
      try {
        await file.writeFile(`${JSON.stringify({ pid, since: Date.now() })}\n`);
      } finally {
        await file.close();
      }
      break;
    } catch {
      // Taken. Either somebody is speaking, or the file outlived the Player that wrote it — and
      // only the second is ours to clear, exactly once, before trying again.
      if (attempt > 0) return null;
      if (!(await isAbandoned(options))) return null;
      await rm(narrateLockPath(), { force: true });
    }
  }

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
