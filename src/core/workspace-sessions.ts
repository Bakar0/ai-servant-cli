// Who is working in a workspace right now, read from the session registry rather than asked.
//
// ADR 0010 decision 3: liveness is a free file read, and a session's *name* is its address — so a
// name says what a session is for. `<ws>-t<n>` carries ticket n, `<ws>-hands` is the Summons agent's
// own hands, and anything else is a session the user started by hand. The registry degrades to
// unknown, and so does this: "the registry could not be read" must never be reported as "nobody is
// working", which is the answer that gets two sessions into one worktree.

import { listWorkspaceSessions } from "./claude-session.ts";
import { workspacePath } from "./paths.ts";
import { type LiveSession, readLiveSessions } from "./session-registry.ts";
import { handsSessionName, sessionNameSlug } from "./session-name.ts";

export type WorkspaceSessionKind = "worker" | "hands" | "other";

export interface WorkspaceSession {
  name: string;
  kind: WorkspaceSessionKind;
  /** The ticket a Worker session carries, read from its name. */
  ticket: number | null;
  /** Whatever the registry reports ("idle", "busy", …), or null when it says nothing. */
  status: string | null;
  pid: number;
}

export type WorkspaceSessionsReport =
  /** This host has no readable registry — it says nothing about anyone, which is not "nobody". */
  { known: false } | { known: true; sessions: WorkspaceSession[] };

function classify(
  name: string,
  workspace: string,
): { kind: WorkspaceSessionKind; ticket: number | null } {
  // Built from the slug, which is `[a-z0-9-]` by construction, so there is nothing here for a
  // workspace name to smuggle into the pattern.
  const ticketed = new RegExp(`^${sessionNameSlug(workspace)}-t(\\d+)$`).exec(name);
  if (ticketed) return { kind: "worker", ticket: Number(ticketed[1]) };
  return { kind: name === handsSessionName(workspace) ? "hands" : "other", ticket: null };
}

/**
 * A session belongs to a workspace when it is running inside it — the workspace root or under it.
 * The trailing separator is what keeps `…/workspaces/api` from claiming `…/workspaces/api-old`.
 */
function inWorkspace(session: LiveSession, root: string): boolean {
  return session.cwd === root || (session.cwd?.startsWith(`${root}/`) ?? false);
}

/**
 * The registry is undocumented internals and version skew is already observable (ADR 0010). If it
 * hands back entries and *none* of them carries the two fields this reads, the shape has moved
 * under us — and the honest answer is that nothing is known, not that nobody is working. Reporting
 * an empty workspace from a registry we have stopped understanding is the answer that puts two
 * sessions in one worktree.
 */
function unreadable(sessions: readonly LiveSession[]): boolean {
  return sessions.length > 0 && sessions.every((s) => s.name === null || s.cwd === null);
}

export interface WorkspaceSessionsDeps {
  /** Injected in tests, so the report is asserted without this machine's real sessions in it. */
  live?: typeof readLiveSessions;
}

/** Every live session working in one workspace, newest information the registry has. */
export async function readWorkspaceSessions(
  workspace: string,
  deps: WorkspaceSessionsDeps = {},
): Promise<WorkspaceSessionsReport> {
  const live = await (deps.live ?? readLiveSessions)();
  if (!live.known || unreadable(live.sessions)) return { known: false };
  const root = workspacePath(workspace);
  const sessions = live.sessions
    .filter((session): session is LiveSession & { name: string } =>
      Boolean(session.name && inWorkspace(session, root)),
    )
    .map((session) => ({
      name: session.name,
      ...classify(session.name, workspace),
      status: session.status,
      pid: session.pid,
    }));
  return { known: true, sessions };
}

/** What one named session has said. Unknown is not "it said nothing" — see below. */
export type SessionLatestReport =
  | { known: false }
  | { known: true; turns: number; latest: string | null };

/**
 * The most this can be read from a session without asking it anything.
 *
 * Two hops, because the two stores hold different halves: the live registry knows a session's *name*
 * and its Claude session id, and the transcript store knows what it has said. Neither knows both, so
 * a name is resolved through the registry to an id and the id to a transcript.
 *
 * Every failure along the way is `known: false` rather than an empty answer. "Its transcript could
 * not be found" and "it has said nothing yet" look identical from a caller that conflates them, and
 * the second one is what makes a Summons report silence as an answer.
 */
export async function readSessionLatest(
  workspace: string,
  name: string,
  deps: WorkspaceSessionsDeps & { transcripts?: typeof listWorkspaceSessions } = {},
): Promise<SessionLatestReport> {
  const live = await (deps.live ?? readLiveSessions)();
  if (!live.known) return { known: false };
  const root = workspacePath(workspace);
  const match = live.sessions.find((s) => s.name === name && inWorkspace(s, root));
  if (!match?.sessionId) return { known: false };
  const transcripts = await (deps.transcripts ?? listWorkspaceSessions)({
    workspaceName: workspace,
  });
  const meta = transcripts.find((t) => t.sessionId === match.sessionId);
  if (!meta) return { known: false };
  return {
    known: true,
    turns: meta.assistantTurns,
    latest: meta.lastAssistantMessage?.trim() || null,
  };
}
