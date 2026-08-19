// The board store: every read and write servant performs against the tracker.
//
// Deliberately not behind a port interface. A `TrackerPort` with a GitHub adapter and a board
// adapter was considered and rejected (ADR-0011): the GitHub side is being deleted, so it would be
// indirection with one implementation, and it would hide the schema from the tests that most need
// to see it.

import type { Database } from "bun:sqlite";
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

/**
 * How every function here names a ticket: the address a human uses, never the row's global id.
 *
 * The schema keeps both identifiers on purpose (db.ts), but only one of them belongs in a
 * signature. When the split reached the interface too, a caller had to know which of ~23 functions
 * spoke which, and the ones that spoke id could only be reached through a lookup — a
 * `requireTicket(…).id` preamble in front of nearly every write.
 *
 * A `Ticket` satisfies this structurally, so a caller already holding one passes it straight
 * through; a caller holding only an address writes the literal and performs no read at all.
 */
export interface TicketRef {
  workspace: string;
  seq: number;
}

function noSuchTicket(ref: TicketRef): Error {
  return new Error(`No ticket #${ref.seq} on the "${ref.workspace}" board.`);
}

/**
 * An address to the id the rows are keyed on.
 *
 * Deliberately not `findTicket().id`: that hydrates the ticket and reads the whole edge table to do
 * it, which is what made the old lookup-then-write preamble expensive. Resolution needs neither.
 */
function findId(db: Database, ref: TicketRef): number | null {
  const row = db
    .query<{ id: number }, [string, number]>(
      "SELECT t.id FROM tickets t JOIN boards b ON b.id = t.board_id WHERE b.workspace = ? AND t.seq = ?",
    )
    .get(ref.workspace, ref.seq);
  return row?.id ?? null;
}

function requireId(db: Database, ref: TicketRef): number {
  const id = findId(db, ref);
  if (id === null) throw noSuchTicket(ref);
  return id;
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
  /** The map this is a child of. */
  parent?: TicketRef;
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
  const parentId = spec.parent === undefined ? null : requireId(db, spec.parent);
  const seq = spec.seq ?? nextSeq(boardId);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`Ticket seq must be a positive integer, got ${seq}.`);
  }
  return db.transaction(() => {
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
  })();
}

function nextSeq(boardId: number): number {
  const row = openBoard()
    .query<{ next: number }, [number]>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tickets WHERE board_id = ?",
    )
    .get(boardId);
  return row?.next ?? 1;
}

// Not exported: `findTicket` is the one way in from outside, so an id never has to be carried
// around to read a row back. Kept internally because a write already holds the id it just wrote,
// and re-addressing by seq would miss a row the same write had renumbered.
function readById(id: number): Ticket | null {
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
  if (!ticket) throw noSuchTicket({ workspace, seq });
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

/**
 * Who a write is attributed to, and when. Every write that changes board state records its own
 * action row from these, inside the same transaction as the field change — `ticket_actions` is
 * only the complete history db.ts claims it is if recording it is not a thing a caller can forget,
 * and a transfer is only auditable if the row cannot be lost to a crash between two statements.
 */
export interface WriteOptions {
  /** Anything that is not servant writing on its own behalf — the hub importer, so far. */
  actor?: string;
  now?: string;
}

export interface TicketPatch {
  title?: string;
  body?: string;
  status?: string;
  labels?: readonly string[];
  parent?: TicketRef | null;
  input?: Record<string, unknown>;
  /** Renumbering. Safe by construction: edges reference the global id, never this. */
  seq?: number;
}

/**
 * Only status and labels earn an action row: they are what the columns and the triage vocabulary
 * are read from, so a reader asking "how did this get here?" is asking about those two. A
 * retitling or a rewritten body is content, already dated by `updated_at`, and logging it would
 * bury the transitions under the importer restating every field it re-read.
 *
 * A patch that sets a field to what it already holds records nothing — the trail is transitions,
 * and the importer re-reads every field on every run.
 */
export function updateTicket(ref: TicketRef, patch: TicketPatch, opts: WriteOptions = {}): Ticket {
  const db = openBoard();
  if (!Object.values(patch).some((field) => field !== undefined)) {
    return requireTicket(ref.workspace, ref.seq);
  }
  // Validated before the write lock is taken, so a bad status costs nobody a blocked transaction.
  const next: Partial<BoardState> = {
    ...(patch.status === undefined ? {} : { status: assertStatus(patch.status) }),
    ...(patch.labels === undefined ? {} : { labels: JSON.stringify([...patch.labels]) }),
  };
  const at = opts.now ?? new Date().toISOString();
  const id = db
    .transaction(() => {
      const before = requireBoardState(db, ref);
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      const push = (column: string, value: string | number | null) => {
        sets.push(`${column} = ?`);
        params.push(value);
      };
      if (patch.title !== undefined) push("title", patch.title);
      if (patch.body !== undefined) push("body", patch.body);
      if (next.status !== undefined) push("status", next.status);
      if (next.labels !== undefined) push("labels", next.labels);
      if (patch.parent !== undefined) {
        push("parent_id", patch.parent === null ? null : requireId(db, patch.parent));
      }
      if (patch.input !== undefined) push("input", JSON.stringify(patch.input));
      if (patch.seq !== undefined) push("seq", patch.seq);
      push("updated_at", at);
      for (const action of boardStateChanges(before, next)) {
        recordAction(before.id, { ...action, actor: opts.actor, at });
      }
      db.run(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`, [...params, before.id]);
      return before.id;
    })
    .immediate();
  // By id rather than by the address that came in: this write may have been the renumbering.
  const updated = readById(id);
  if (!updated) throw noSuchTicket(ref);
  return updated;
}

/** The columns an action row is written about, as the table stores them, and the row they are on. */
interface BoardState {
  id: number;
  status: string;
  labels: string;
  claimedBy: string | null;
}

// Immediate, and read inside the transaction, for the same reason addDependency is: the row a
// write logs is decided by comparing against the row it replaces, and a decision made against a
// snapshot taken before the write lock can describe a transition that never happened — a transfer
// logged as a first claim. Resolving the address is part of that same read, so a concurrent
// renumbering cannot land the write on a row the caller never named.
function requireBoardState(db: Database, ref: TicketRef): BoardState {
  const row = db
    .query<
      { id: number; status: string; labels: string; claimed_by: string | null },
      [string, number]
    >(
      `SELECT t.id, t.status, t.labels, t.claimed_by FROM tickets t
         JOIN boards b ON b.id = t.board_id
       WHERE b.workspace = ? AND t.seq = ?`,
    )
    .get(ref.workspace, ref.seq);
  if (!row) throw noSuchTicket(ref);
  return { id: row.id, status: row.status, labels: row.labels, claimedBy: row.claimed_by };
}

function boardStateChanges(
  before: BoardState,
  next: Partial<BoardState>,
): { kind: string; body: string }[] {
  const changes: { kind: string; body: string }[] = [];
  if (next.status !== undefined && next.status !== before.status) {
    changes.push({ kind: "status", body: next.status });
  }
  if (next.labels !== undefined && next.labels !== before.labels) {
    changes.push({ kind: "labels", body: jsonOr<string[]>(next.labels, []).join(", ") });
  }
  return changes;
}

/**
 * Take, transfer or release the Claim on a ticket. Which of the three it is, the board reads off
 * the holder it is replacing, so no caller has to work it out and then be trusted to log it.
 *
 * A release is always recorded, even of a ticket nobody held: `servant claim --release` is
 * something a session did, and "there was nothing to let go of" is worth being able to see.
 */
export function updateClaim(
  ref: TicketRef,
  claim: Claim | null,
  opts: WriteOptions & { session?: string } = {},
): void {
  const db = openBoard();
  const at = opts.now ?? claim?.at ?? new Date().toISOString();
  db.transaction(() => {
    const { id, claimedBy: held } = requireBoardState(db, ref);
    if (claim === null) {
      recordAction(id, { kind: "released", actor: opts.actor, session: opts.session ?? held, at });
    } else if (claim.session !== held) {
      recordAction(id, {
        kind: held ? "transferred" : "claimed",
        actor: opts.actor,
        session: claim.session,
        body: held ?? "",
        at,
      });
    }
    db.run("UPDATE tickets SET claimed_by = ?, claimed_at = ? WHERE id = ?", [
      claim?.session ?? null,
      claim?.at ?? null,
      id,
    ]);
  }).immediate();
}

/**
 * Record a dependency, rejecting anything that would stop the graph being a DAG.
 *
 * Checked before the insert rather than repaired after: a cycle makes depth and "is this blocked"
 * both meaningless, and a tracker that has to be swept for consistency is one that will be read
 * while inconsistent.
 */
export function addDependency(
  ticket: TicketRef,
  dependsOn: TicketRef,
  opts: { now?: string } = {},
): void {
  const db = openBoard();
  const at = opts.now ?? new Date().toISOString();
  // Immediate rather than deferred: the write lock is taken before the reachability read, so a
  // second session adding the opposite edge at the same moment cannot slip a cycle past a check
  // made against a snapshot that was already stale. Both addresses resolve under the same lock,
  // for the same reason.
  db.transaction(() => {
    // Resolved before the self-check, and the waiting ticket first, so that two numbers neither of
    // which exists is reported as the missing subject rather than as a self-reference.
    const ticketId = requireId(db, ticket);
    const blockerId = requireId(db, dependsOn);
    if (ticketId === blockerId) throw new Error("A ticket cannot block itself.");
    if (reaches(blockerId, ticketId)) {
      throw new Error(
        `That dependency would create a cycle: ${dependsOn.workspace}#${dependsOn.seq} already waits on ${ticket.workspace}#${ticket.seq}.`,
      );
    }
    db.run(
      "INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on, created_at) VALUES (?, ?, ?)",
      [ticketId, blockerId, at],
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

export function removeDependency(ticket: TicketRef, dependsOn: TicketRef): void {
  const db = openBoard();
  // Both addresses are required to exist even though deleting a missing edge is harmless. It is
  // what `servant ticket unblock` used to get from reading both tickets before calling: without
  // it, a mistyped number reports success, and the edge stays on the board while its owner
  // believes it is gone.
  db.run("DELETE FROM ticket_dependencies WHERE ticket_id = ? AND depends_on = ?", [
    requireId(db, ticket),
    requireId(db, dependsOn),
  ]);
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
  /** Its identity in the system it was carried from, or null for anything servant wrote itself. */
  externalId: string | null;
}

interface ActionRow {
  id: number;
  ticket_id: number;
  actor: string;
  session: string | null;
  kind: string;
  body: string;
  at: string;
  external_id: string | null;
}

export function ticketActions(ref: TicketRef): TicketAction[] {
  const db = openBoard();
  const ticketId = requireId(db, ref);
  return db
    .query<ActionRow, [number]>(
      `SELECT id, ticket_id, actor, session, kind, body, at, external_id FROM ticket_actions
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
      externalId: r.external_id,
    }));
}

// Deliberately not exported: an audit row a caller can write is one a caller can forget to write,
// which is how the label change went unlogged.
function recordAction(
  ticketId: number,
  action: {
    kind: string;
    actor?: string | undefined;
    session?: string | null;
    body?: string;
    at?: string;
  },
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
  ref: TicketRef,
  body: string,
  opts: { session?: string | undefined; now?: string } = {},
): void {
  const db = openBoard();
  recordAction(requireId(db, ref), {
    kind: "comment",
    session: opts.session ?? null,
    body,
    at: opts.now ?? new Date().toISOString(),
  });
}

/**
 * Carry a comment that was written somewhere else, keyed on its identity there.
 *
 * Returns false when that comment is already on the board. `ticket_actions` is append-only with no
 * natural key, so an importer that re-ran would otherwise duplicate everything it had carried; the
 * unique index makes the second run a no-op rather than a thing the caller has to remember.
 */
export function carryComment(
  ref: TicketRef,
  comment: { externalId: string; actor: string; body: string; at: string },
): boolean {
  const db = openBoard();
  const { changes } = db.run(
    `INSERT OR IGNORE INTO ticket_actions (ticket_id, actor, session, kind, body, at, external_id)
     VALUES (?, ?, NULL, 'comment', ?, ?, ?)`,
    [requireId(db, ref), comment.actor, comment.body, comment.at, comment.externalId],
  );
  return changes > 0;
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

/**
 * Read by `claimView` in view.ts, which turns it into the "· 4m" age beside a claim badge. Only an
 * age: whether the session is still alive is `ClaimView.state`, which the frontier's PID check
 * fills in (ADR-0011 decision 3).
 */
export function sessionLastSeen(name: string): { pid: number | null; lastSeen: string } | null {
  const row = openBoard()
    .query<{ pid: number | null; last_seen: string }, [string]>(
      "SELECT pid, last_seen FROM sessions WHERE name = ?",
    )
    .get(name);
  return row ? { pid: row.pid, lastSeen: row.last_seen } : null;
}
