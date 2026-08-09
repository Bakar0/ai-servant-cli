// Liveness of Claude sessions, read from `~/.claude/sessions/<pid>.json`.
//
// This is undocumented internals: the published docs promise only "files on disk", and version skew
// is already observable in the wild. So it is one adapter, and every failure mode — missing dir,
// unparseable file, a field that moved — degrades to *unknown* (workspace ADR 0010).
//
// Unknown is a distinct answer from "gone", and the distinction is load-bearing: reading a registry
// this host does not have as "that session ended" would free a repo whose worktree is still being
// worked in, which is the exact collision ADR 0010 exists to prevent.

import { homedir } from "node:os";
import { join } from "node:path";

export interface LiveSession {
  pid: number;
  name: string | null;
  sessionId: string | null;
  cwd: string | null;
  /** Whatever the registry reports ("idle", "busy", …); not interpreted here. */
  status: string | null;
}

export type SessionLiveness =
  /** The registry could not be read at all — this host says nothing about any session. */
  | { known: false }
  /** The registry was read; `session` is null when it holds no such name. */
  | { known: true; session: LiveSession | null };

function claudeSessionsRoot(): string {
  return join(homedir(), ".claude", "sessions");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A registry entry is only evidence a session *was* started — the file outlives a crash. The PID is
 * what says it is still there, so it is checked rather than trusted.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type LiveSessions =
  /** The registry could not be read at all — this host says nothing about any session. */
  { known: false } | { known: true; sessions: LiveSession[] };

/**
 * Every session this host says is alive. The pull half of ADR 0010: asking a session what it is
 * doing costs it a full turn, while this costs a directory scan — so status, liveness and "who is
 * on this" are read, never asked.
 */
export async function readLiveSessions(): Promise<LiveSessions> {
  const root = claudeSessionsRoot();
  let files: string[];
  try {
    files = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: root, onlyFiles: true }));
  } catch {
    return { known: false };
  }
  const sessions: LiveSession[] = [];
  for (const file of files) {
    let raw: Record<string, unknown>;
    try {
      raw = (await Bun.file(join(root, file)).json()) as Record<string, unknown>;
    } catch {
      continue; // one unreadable entry says nothing about the rest
    }
    const pid = typeof raw.pid === "number" ? raw.pid : Number(file.replace(/\.json$/, ""));
    if (!Number.isFinite(pid) || !isAlive(pid)) continue;
    sessions.push({
      pid,
      name: str(raw.name),
      sessionId: str(raw.sessionId),
      cwd: str(raw.cwd),
      status: str(raw.status),
    });
  }
  return { known: true, sessions };
}

/** What the registry knows about the session going by `name`. */
export async function readSessionLiveness(name: string): Promise<SessionLiveness> {
  const live = await readLiveSessions();
  if (!live.known) return { known: false };
  return { known: true, session: live.sessions.find((s) => s.name === name) ?? null };
}
