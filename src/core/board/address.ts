// How a ticket number on the command line becomes a board plus a seq.
//
// A seq is only unique within a board (ADR-0011 decision 4), so `servant claim 76` needs to know
// which board. Three sources, most explicit first — and a session name is a genuine source rather
// than a guess, because ADR-0010 decision 1 makes `<workspace>-t<ticket>` the address a session is
// reached by, so the name already carries the answer.

import { resolveWorkspaceName } from "../workspace.ts";

export function parseSeq(raw: unknown, command: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${command}: <ticket> must be a positive ticket number on the board.`);
  }
  return n;
}

/** The workspace a session name encodes, when it is the address of this very ticket. */
export function workspaceFromSessionName(session: string, seq: number): string | null {
  const match = new RegExp(`^(.+)-t${seq}$`).exec(session.trim());
  return match?.[1] ?? null;
}

export async function resolveBoardWorkspace(opts: {
  ws?: string | undefined;
  session?: string | undefined;
  seq?: number | undefined;
}): Promise<string> {
  const explicit = opts.ws?.trim();
  if (explicit) return explicit;
  if (opts.session && opts.seq !== undefined) {
    const fromSession = workspaceFromSessionName(opts.session, opts.seq);
    if (fromSession) return fromSession;
  }
  return resolveWorkspaceName(undefined);
}
