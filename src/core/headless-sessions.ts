import { mkdir, readFile } from "node:fs/promises";
import { cacheDir, headlessSessionsPath } from "./paths.ts";

// The servant runs headless `claude -p` sessions of its own (memory extraction, insight judging).
// Those sessions land transcripts under ~/.claude/projects just like a user's, so the pull-side
// session listing would otherwise *measure the servant measuring itself*. The live recorder used
// to skip them via an env marker at write time, but that recorder is gone (ADR-002), so exclusion
// now lives here: a headless run registers its (pre-generated) session id before it spawns, and
// the listing side reads this set to skip them. Registering up front means a crash mid-run still
// leaves the session excluded.

async function readIds(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(headlessSessionsPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The set of session ids servant created headlessly. Empty when nothing was ever registered. */
export async function readHeadlessSessionIds(): Promise<Set<string>> {
  return new Set(await readIds());
}

/** Record a session id as servant-headless so the listing/metrics side skips it. Idempotent. */
export async function registerHeadlessSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const ids = await readIds();
  if (ids.includes(sessionId)) return;
  ids.push(sessionId);
  await mkdir(cacheDir(), { recursive: true });
  await Bun.write(headlessSessionsPath(), `${JSON.stringify(ids, null, 2)}\n`);
}
