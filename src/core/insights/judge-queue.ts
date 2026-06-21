import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cacheDir, judgeLockPath, judgeQueuePath, judgeStatusPath } from "../paths.ts";

// The judgment pass mirrors memory extraction's contract: the SessionEnd hook only ever *appends*
// a job here (instant, spawns no claude), and a single lockfile-guarded drainer processes the queue
// with headless `claude -p`. Unlike extraction there is no turn marker — idempotency comes from the
// per-session judgment record itself (an anchor is judged at most once), so this queue stays thin.

export interface JudgeJob {
  session_id: string;
  transcript_path: string;
  workspace: string | null;
  cwd: string;
  ts: number;
}

export async function enqueueJudgeJob(job: JudgeJob): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  const file = Bun.file(judgeQueuePath());
  const prev = (await file.exists()) ? await file.text() : "";
  await Bun.write(judgeQueuePath(), `${prev}${JSON.stringify(job)}\n`);
}

export async function readJudgeJobs(): Promise<JudgeJob[]> {
  const file = Bun.file(judgeQueuePath());
  if (!(await file.exists())) return [];
  const text = await file.text();
  const jobs: JudgeJob[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      jobs.push(JSON.parse(trimmed) as JudgeJob);
    } catch {
      // skip malformed lines
    }
  }
  return jobs;
}

export async function judgeQueueDepth(): Promise<number> {
  return (await readJudgeJobs()).length;
}

export async function clearJudgeQueue(): Promise<void> {
  await rm(judgeQueuePath(), { force: true });
}

// --- Lockfile (only one judgment drainer ever runs) ---

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
    return JSON.parse(await readFile(judgeLockPath(), "utf8")) as LockData;
  } catch {
    return null;
  }
}

/** Try to acquire the judgment drainer lock. Returns true on success (steals a stale lock). */
export async function acquireJudgeLock(now: number = Date.now()): Promise<boolean> {
  await mkdir(cacheDir(), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, ts: now } satisfies LockData);
  try {
    await writeFile(judgeLockPath(), payload, { flag: "wx" });
    return true;
  } catch {
    const existing = await readLock();
    const stale = !existing || !pidAlive(existing.pid) || now - existing.ts > STALE_LOCK_MS;
    if (!stale) return false;
    await writeFile(judgeLockPath(), payload);
    return true;
  }
}

export async function releaseJudgeLock(): Promise<void> {
  await rm(judgeLockPath(), { force: true });
}

export function judgeLockHeld(): boolean {
  return existsSync(judgeLockPath());
}

// --- Drainer run status (retrospective visibility) ---

export interface JudgeDrainStatus {
  /** When the last drain run finished (epoch ms). */
  ts: number;
  /** How many queued jobs that run produced/updated a judgment record for. */
  processed: number;
  /** Total judgments written across this run. */
  judged?: number;
  /** First error encountered during the run, if any. */
  error?: string;
}

export async function readJudgeStatus(): Promise<JudgeDrainStatus | null> {
  try {
    return JSON.parse(await readFile(judgeStatusPath(), "utf8")) as JudgeDrainStatus;
  } catch {
    return null;
  }
}

export async function writeJudgeStatus(status: JudgeDrainStatus): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await Bun.write(judgeStatusPath(), `${JSON.stringify(status, null, 2)}\n`);
}
