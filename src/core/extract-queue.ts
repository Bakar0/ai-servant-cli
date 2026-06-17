import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  cacheDir,
  extractLockPath,
  extractMarkersPath,
  extractQueuePath,
  extractStatusPath,
} from "./paths.ts";

// A SessionEnd hook only ever *appends* a job here (instant, spawns no claude); a single
// lockfile-guarded drainer processes the queue with headless `claude -p`. Keeping the
// queue dumb is what lets a burst of `/clear`s just lengthen the line instead of
// spawning concurrent extraction processes.

export interface ExtractJob {
  session_id: string;
  transcript_path: string;
  workspace: string | null;
  cwd: string;
  ts: number;
}

export async function enqueueJob(job: ExtractJob): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  const file = Bun.file(extractQueuePath());
  const prev = (await file.exists()) ? await file.text() : "";
  await Bun.write(extractQueuePath(), `${prev}${JSON.stringify(job)}\n`);
}

export async function readJobs(): Promise<ExtractJob[]> {
  const file = Bun.file(extractQueuePath());
  if (!(await file.exists())) return [];
  const text = await file.text();
  const jobs: ExtractJob[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      jobs.push(JSON.parse(trimmed) as ExtractJob);
    } catch {
      // skip malformed lines
    }
  }
  return jobs;
}

export async function queueDepth(): Promise<number> {
  return (await readJobs()).length;
}

export async function clearQueue(): Promise<void> {
  await rm(extractQueuePath(), { force: true });
}

// --- Lockfile (only one drainer ever runs) ---

interface LockData {
  pid: number;
  ts: number;
}

const STALE_LOCK_MS = 10 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead); EPERM = alive but not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(): Promise<LockData | null> {
  try {
    return JSON.parse(await readFile(extractLockPath(), "utf8")) as LockData;
  } catch {
    return null;
  }
}

/** Try to acquire the drainer lock. Returns true on success (steals a stale lock). */
export async function acquireLock(now: number = Date.now()): Promise<boolean> {
  await mkdir(cacheDir(), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, ts: now } satisfies LockData);
  try {
    await writeFile(extractLockPath(), payload, { flag: "wx" });
    return true;
  } catch {
    // Lock exists — steal it if the holder is dead or it's older than the staleness window.
    const existing = await readLock();
    const stale = !existing || !pidAlive(existing.pid) || now - existing.ts > STALE_LOCK_MS;
    if (!stale) return false;
    await writeFile(extractLockPath(), payload);
    return true;
  }
}

export async function releaseLock(): Promise<void> {
  await rm(extractLockPath(), { force: true });
}

export function lockHeld(): boolean {
  return existsSync(extractLockPath());
}

// --- Incremental "extracted up to turn N" markers (per session) ---

async function readMarkers(): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(extractMarkersPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export async function getMarker(sessionId: string): Promise<number> {
  return (await readMarkers())[sessionId] ?? 0;
}

export async function setMarker(sessionId: string, turn: number): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  const markers = await readMarkers();
  markers[sessionId] = turn;
  await Bun.write(extractMarkersPath(), `${JSON.stringify(markers, null, 2)}\n`);
}

// --- Drainer run status (retrospective visibility, no tabs/notifications) ---

export interface DrainStatus {
  /** When the last drain run finished (epoch ms). */
  ts: number;
  /** How many queued jobs that run processed. */
  processed: number;
  /** Each processed job's final summary line (e.g. "added/updated 3 notes"). */
  summaries?: string[];
  /** First error encountered during the run, if any. */
  error?: string;
}

export async function readDrainStatus(): Promise<DrainStatus | null> {
  try {
    return JSON.parse(await readFile(extractStatusPath(), "utf8")) as DrainStatus;
  } catch {
    return null;
  }
}

export async function writeDrainStatus(status: DrainStatus): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await Bun.write(extractStatusPath(), `${JSON.stringify(status, null, 2)}\n`);
}
