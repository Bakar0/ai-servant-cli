// The board store: every read and write servant performs against the tracker.
//
// Deliberately not behind a port interface. A `TrackerPort` with a GitHub adapter and a board
// adapter was considered and rejected (ADR-0011): the GitHub side is being deleted, so it would be
// indirection with one implementation, and it would hide the schema from the tests that most need
// to see it.

import { ticketUrl } from "../paths.ts";
import { openBoard } from "./db.ts";

export { closeBoard } from "./db.ts";

/**
 * Stored ticket state. `blocked` and `ready` are **not** here: both are derived from open
 * dependencies, so they cannot drift from the frontier the CLI reports.
 */
export type TicketStatus = "todo" | "in_progress" | "in_review" | "done";

const STATUSES: readonly TicketStatus[] = ["todo", "in_progress", "in_review", "done"];

/** Which statuses count as still-open work. The frontier only ever looks at these. */
export function isOpenStatus(status: TicketStatus): boolean {
  return status !== "done";
}

export function assertStatus(raw: string): TicketStatus {
  if (!STATUSES.includes(raw as TicketStatus)) {
    throw new Error(`Unknown ticket status "${raw}". Expected one of: ${STATUSES.join(", ")}.`);
  }
  return raw as TicketStatus;
}

/** Who is carrying a ticket, and since when (ADR-0011 decision 2 — the assignment half). */
export interface Claim {
  session: string;
  at: string;
}

export interface Ticket {
  /** Global, stable, and what every stored edge references. */
  id: number;
  workspace: string;
  /** Board-scoped, small, and what every human-facing surface shows. */
  seq: number;
  title: string;
  body: string;
  status: TicketStatus;
  labels: string[];
  claim: Claim | null;
  /** The map a wayfinder child hangs off, by global id. */
  parentId: number | null;
  input: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Global ids of the tickets this one waits on. */
  blockedBy: number[];
  /** Global ids of the tickets waiting on this one — the question the hub could not answer. */
  blocks: number[];
  /** Deep link into the viewer. Loopback only; nothing off this machine can follow it. */
  url: string;
}

export type TicketState = "open" | "closed" | "all";

interface TicketRow {
  id: number;
  workspace: string;
  seq: number;
  title: string;
  body: string;
  status: string;
  labels: string;
  claimed_by: string | null;
  claimed_at: string | null;
  parent_id: number | null;
  input: string;
  created_at: string;
  updated_at: string;
}

const TICKET_COLUMNS = `t.id, b.workspace, t.seq, t.title, t.body, t.status, t.labels,
  t.claimed_by, t.claimed_at, t.parent_id, t.input, t.created_at, t.updated_at`;

function jsonOr<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function hydrate(row: TicketRow, edges: EdgeIndex): Ticket {
  return {
    id: row.id,
    workspace: row.workspace,
    seq: row.seq,
    title: row.title,
    body: row.body,
    status: assertStatus(row.status),
    labels: jsonOr<string[]>(row.labels, []),
    claim: row.claimed_by ? { session: row.claimed_by, at: row.claimed_at ?? "" } : null,
    parentId: row.parent_id,
    input: jsonOr<Record<string, unknown>>(row.input, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blockedBy: edges.blockedBy.get(row.id) ?? [],
    blocks: edges.blocks.get(row.id) ?? [],
    url: ticketUrl(row.workspace, row.seq),
  };
}

interface EdgeIndex {
  blockedBy: Map<number, number[]>;
  blocks: Map<number, number[]>;
}

/**
 * Every edge on the board, in both directions, in one read.
 *
 * Whole-table rather than per-ticket because the callers that want edges at all (the frontier, the
 * map, a card's blockers) all want them for a set of tickets, and a personal backlog is not the
 * scale at which that matters.
 */
function readEdges(): EdgeIndex {
  const rows = openBoard()
    .query<{ ticket_id: number; depends_on: number }, []>(
      "SELECT ticket_id, depends_on FROM ticket_dependencies ORDER BY depends_on",
    )
    .all();
  const blockedBy = new Map<number, number[]>();
  const blocks = new Map<number, number[]>();
  for (const { ticket_id, depends_on } of rows) {
    const on = blockedBy.get(ticket_id);
    if (on) on.push(depends_on);
    else blockedBy.set(ticket_id, [depends_on]);
    const by = blocks.get(depends_on);
    if (by) by.push(ticket_id);
    else blocks.set(depends_on, [ticket_id]);
  }
  return { blockedBy, blocks };
}

/**
 * A counter SQLite bumps whenever **another connection** commits — the cheapest honest answer to
 * "has anything changed?".
 *
 * The viewer polls this instead of watching the file. Watching was tried first and does not work:
 * a WAL commit appends to `board.sqlite-wal` and may never touch `board.sqlite`, and macOS reports
 * nothing at all for a plain append, so a filesystem watch misses most writes. This misses nothing
 * a different process committed, and it deliberately does not move for the caller's own writes.
 */
export function boardDataVersion(): number {
  const row = openBoard().query<{ data_version: number }, []>("PRAGMA data_version").get();
  return row?.data_version ?? 0;
}

/** Board ids by workspace name. A workspace *is* a board (ADR-0011 decision 5). */
export function listBoards(): string[] {
  return openBoard()
    .query<{ workspace: string }, []>("SELECT workspace FROM boards ORDER BY workspace")
    .all()
    .map((r) => r.workspace);
}

/** The board for a workspace, created if this is the first ticket it has ever carried. */
export function ensureBoard(workspace: string, opts: { now?: string } = {}): number {
  const db = openBoard();
  const existing = db
    .query<{ id: number }, [string]>("SELECT id FROM boards WHERE workspace = ?")
    .get(workspace);
  if (existing) return existing.id;
  db.run("INSERT INTO boards (workspace, created_at) VALUES (?, ?)", [
    workspace,
    opts.now ?? new Date().toISOString(),
  ]);
  const created = db
    .query<{ id: number }, [string]>("SELECT id FROM boards WHERE workspace = ?")
    .get(workspace);
  if (!created) throw new Error(`Could not create the board for workspace "${workspace}".`);
  return created.id;
}

export interface CreateTicketInput {
  workspace: string;
  title: string;
  body?: string;
  labels?: readonly string[];
  status?: string;
  /** The map this is a child of, by seq on the same board. */
  parentSeq?: number;
  input?: Record<string, unknown>;
  /** Forced seq — the importer preserving a hub issue number. Otherwise the next free one. */
  seq?: number;
  now?: string;
}

export function createTicket(spec: CreateTicketInput): Ticket {
  const db = openBoard();
  const now = spec.now ?? new Date().toISOString();
  const status = assertStatus(spec.status ?? "todo");
  const boardId = ensureBoard(spec.workspace, { now });
  const parentId =
    spec.parentSeq === undefined ? null : requireTicket(spec.workspace, spec.parentSeq).id;
  const seq = spec.seq ?? nextSeq(boardId);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`Ticket seq must be a positive integer, got ${seq}.`);
  }
  db.run(
    `INSERT INTO tickets (board_id, seq, title, body, status, labels, parent_id, input,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      boardId,
      seq,
      spec.title,
      spec.body ?? "",
      status,
      JSON.stringify([...(spec.labels ?? [])]),
      parentId,
      JSON.stringify(spec.input ?? {}),
      now,
      now,
    ],
  );
  const created = requireTicket(spec.workspace, seq);
  recordAction(created.id, { kind: "created", actor: "servant", at: now });
  return created;
}

function nextSeq(boardId: number): number {
  const row = openBoard()
    .query<{ next: number }, [number]>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tickets WHERE board_id = ?",
    )
    .get(boardId);
  return row?.next ?? 1;
}

export function readTicket(id: number): Ticket | null {
  const row = openBoard()
    .query<TicketRow, [number]>(
      `SELECT ${TICKET_COLUMNS} FROM tickets t JOIN boards b ON b.id = t.board_id WHERE t.id = ?`,
    )
    .get(id);
  return row ? hydrate(row, readEdges()) : null;
}

/** A ticket by the address a human uses: which board, and which number on it. */
export function findTicket(workspace: string, seq: number): Ticket | null {
  const row = openBoard()
    .query<TicketRow, [string, number]>(
      `SELECT ${TICKET_COLUMNS} FROM tickets t JOIN boards b ON b.id = t.board_id
       WHERE b.workspace = ? AND t.seq = ?`,
    )
    .get(workspace, seq);
  return row ? hydrate(row, readEdges()) : null;
}

export function requireTicket(workspace: string, seq: number): Ticket {
  const ticket = findTicket(workspace, seq);
  if (!ticket) throw new Error(`No ticket #${seq} on the "${workspace}" board.`);
  return ticket;
}

export function listTickets(
  opts: { workspace?: string | undefined; state?: TicketState } = {},
): Ticket[] {
  const state = opts.state ?? "all";
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.workspace) {
    where.push("b.workspace = ?");
    params.push(opts.workspace);
  }
  if (state === "open") where.push("t.status <> 'done'");
  if (state === "closed") where.push("t.status = 'done'");
  const rows = openBoard()
    .query<TicketRow, (string | number)[]>(
      `SELECT ${TICKET_COLUMNS} FROM tickets t JOIN boards b ON b.id = t.board_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY b.workspace, t.seq`,
    )
    .all(...params);
  const edges = readEdges();
  return rows.map((row) => hydrate(row, edges));
}

export interface TicketPatch {
  title?: string;
  body?: string;
  status?: string;
  labels?: readonly string[];
  parentId?: number | null;
  input?: Record<string, unknown>;
  /** Renumbering. Safe by construction: edges reference the global id, never this. */
  seq?: number;
}

export function updateTicket(id: number, patch: TicketPatch, opts: { now?: string } = {}): Ticket {
  const db = openBoard();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.title !== undefined) push("title", patch.title);
  if (patch.body !== undefined) push("body", patch.body);
  if (patch.status !== undefined) push("status", assertStatus(patch.status));
  if (patch.labels !== undefined) push("labels", JSON.stringify([...patch.labels]));
  if (patch.parentId !== undefined) push("parent_id", patch.parentId);
  if (patch.input !== undefined) push("input", JSON.stringify(patch.input));
  if (patch.seq !== undefined) push("seq", patch.seq);
  if (sets.length === 0) {
    const unchanged = readTicket(id);
    if (!unchanged) throw new Error(`No ticket with id ${id}.`);
    return unchanged;
  }
  push("updated_at", opts.now ?? new Date().toISOString());
  params.push(id);
  db.run(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`, params);
  const updated = readTicket(id);
  if (!updated) throw new Error(`No ticket with id ${id}.`);
  return updated;
}

/**
 * Set or clear the assignment half of a Claim. The append-only half is a `ticket_actions` row —
 * see `claims.ts`, which owns the protocol; this is only the field write.
 */
export function updateClaim(id: number, claim: Claim | null): void {
  openBoard().run("UPDATE tickets SET claimed_by = ?, claimed_at = ? WHERE id = ?", [
    claim?.session ?? null,
    claim?.at ?? null,
    id,
  ]);
}

/**
 * Record a dependency, rejecting anything that would stop the graph being a DAG.
 *
 * Checked before the insert rather than repaired after: a cycle makes depth and "is this blocked"
 * both meaningless, and a tracker that has to be swept for consistency is one that will be read
 * while inconsistent.
 */
export function addDependency(
  ticketId: number,
  dependsOn: number,
  opts: { now?: string } = {},
): void {
  if (ticketId === dependsOn) throw new Error("A ticket cannot block itself.");
  const db = openBoard();
  const at = opts.now ?? new Date().toISOString();
  // Immediate rather than deferred: the write lock is taken before the reachability read, so a
  // second session adding the opposite edge at the same moment cannot slip a cycle past a check
  // made against a snapshot that was already stale.
  db.transaction(() => {
    for (const id of [ticketId, dependsOn]) {
      if (!db.query<{ id: number }, [number]>("SELECT id FROM tickets WHERE id = ?").get(id)) {
        throw new Error(`No ticket with id ${id}.`);
      }
    }
    if (reaches(dependsOn, ticketId)) {
      throw new Error(
        `That dependency would create a cycle: ${dependsOn} already waits on ${ticketId}.`,
      );
    }
    db.run(
      "INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on, created_at) VALUES (?, ?, ?)",
      [ticketId, dependsOn, at],
    );
  }).immediate();
}

/** True when `from` transitively waits on `target` — one recursive walk of the join table. */
function reaches(from: number, target: number): boolean {
  const row = openBoard()
    .query<{ hit: number }, [number, number]>(
      `WITH RECURSIVE waits_on(id) AS (
         SELECT depends_on FROM ticket_dependencies WHERE ticket_id = ?
         UNION
         SELECT d.depends_on FROM ticket_dependencies d JOIN waits_on w ON d.ticket_id = w.id
       )
       SELECT 1 AS hit FROM waits_on WHERE id = ? LIMIT 1`,
    )
    .get(from, target);
  return row !== null;
}

export function removeDependency(ticketId: number, dependsOn: number): void {
  openBoard().run("DELETE FROM ticket_dependencies WHERE ticket_id = ? AND depends_on = ?", [
    ticketId,
    dependsOn,
  ]);
}

/** The tickets waiting on this one — "what does leaving this undone cost?". */
export function dependentsOf(id: number): Ticket[] {
  const rows = openBoard()
    .query<TicketRow, [number]>(
      `SELECT ${TICKET_COLUMNS} FROM ticket_dependencies d
         JOIN tickets t ON t.id = d.ticket_id
         JOIN boards b ON b.id = t.board_id
       WHERE d.depends_on = ? ORDER BY b.workspace, t.seq`,
    )
    .all(id);
  const edges = readEdges();
  return rows.map((row) => hydrate(row, edges));
}

/**
 * Dependency depth counting **only open blockers**, per board.
 *
 * A closed ticket is `null` — receded, not numbered — and an open ticket whose blockers have all
 * closed is 0, which makes depth 0 exactly the frontier's ready set. Static longest-path depth was
 * tried and rejected by prototype: it put a ticket in a "next" column while its own state read
 * ready, because the label promised time and the computation described structure (ADR-0011).
 *
 * A different question from cycle detection, though it walks the same table: this one wants the
 * longest still-open chain, not mere reachability.
 */
export function openBlockerDepths(workspace: string): Map<number, number | null> {
  const all = listTickets();
  const open = new Set(all.filter((t) => isOpenStatus(t.status)).map((t) => t.id));
  const blockers = new Map(all.map((t) => [t.id, t.blockedBy.filter((id) => open.has(id))]));
  const depths = new Map<number, number | null>();
  const walking = new Set<number>();
  const depthOf = (id: number): number => {
    const known = depths.get(id);
    if (typeof known === "number") return known;
    // A cycle cannot be written through addDependency; if one somehow exists, refuse to hang.
    if (walking.has(id)) return 0;
    walking.add(id);
    const chain = (blockers.get(id) ?? []).map(depthOf);
    walking.delete(id);
    const depth = chain.length === 0 ? 0 : 1 + Math.max(...chain);
    depths.set(id, depth);
    return depth;
  };
  const out = new Map<number, number | null>();
  for (const ticket of all) {
    if (ticket.workspace !== workspace) continue;
    out.set(ticket.id, open.has(ticket.id) ? depthOf(ticket.id) : null);
  }
  return out;
}

export interface TicketAction {
  id: number;
  ticketId: number;
  actor: string;
  session: string | null;
  kind: string;
  body: string;
  at: string;
}

interface ActionRow {
  id: number;
  ticket_id: number;
  actor: string;
  session: string | null;
  kind: string;
  body: string;
  at: string;
}

export function ticketActions(ticketId: number): TicketAction[] {
  return openBoard()
    .query<ActionRow, [number]>(
      `SELECT id, ticket_id, actor, session, kind, body, at FROM ticket_actions
       WHERE ticket_id = ? ORDER BY id`,
    )
    .all(ticketId)
    .map((r) => ({
      id: r.id,
      ticketId: r.ticket_id,
      actor: r.actor,
      session: r.session,
      kind: r.kind,
      body: r.body,
      at: r.at,
    }));
}

export function recordAction(
  ticketId: number,
  action: { kind: string; actor?: string; session?: string | null; body?: string; at?: string },
): void {
  openBoard().run(
    "INSERT INTO ticket_actions (ticket_id, actor, session, kind, body, at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      ticketId,
      action.actor ?? "servant",
      action.session ?? null,
      action.kind,
      action.body ?? "",
      action.at ?? new Date().toISOString(),
    ],
  );
}

export function addComment(
  ticketId: number,
  body: string,
  opts: { session?: string | undefined; now?: string } = {},
): void {
  recordAction(ticketId, {
    kind: "comment",
    session: opts.session ?? null,
    body,
    at: opts.now ?? new Date().toISOString(),
  });
}

export interface SeenSession {
  name: string;
  pid: number | null;
}

/**
 * Refresh the last-seen projection from whatever the session registry just reported.
 *
 * Upsert-only, never a delete: a session missing from one observation may simply not have been
 * observable, and this table is a cache of when a session was last seen alive — the authority on
 * whether it still is stays the PID check (ADR-0011 decision 3).
 */
export function recordSessionsSeen(
  sessions: readonly SeenSession[],
  opts: { now?: string } = {},
): void {
  const db = openBoard();
  const at = opts.now ?? new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO sessions (name, pid, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET pid = excluded.pid, last_seen = excluded.last_seen`,
  );
  db.transaction(() => {
    for (const session of sessions) upsert.run(session.name, session.pid, at);
  })();
}

export function sessionLastSeen(name: string): { pid: number | null; lastSeen: string } | null {
  const row = openBoard()
    .query<{ pid: number | null; last_seen: string }, [string]>(
      "SELECT pid, last_seen FROM sessions WHERE name = ?",
    )
    .get(name);
  return row ? { pid: row.pid, lastSeen: row.last_seen } : null;
}
