// The board's SQLite file — the tracker's contract (ADR-0011 decision 1).
//
// Every servant command opens this file directly. No server mediates writes, which is what makes
// the CLI work whether or not a viewer is running: the viewer is a lens on this file, not a gate in
// front of it. WAL mode is what lets two sessions write concurrently.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { boardDbPath } from "../paths.ts";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE boards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace  TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Two identifiers on purpose (ADR-0011 decision 4): everything a human or a session sees uses
-- board-scoped seq, so \`<workspace>-t<seq>\` stays a short address; everything stored references
-- the global id, so renumbering and importing cannot silently break an edge.
CREATE TABLE tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq > 0),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'todo',
  labels     TEXT NOT NULL DEFAULT '[]',
  claimed_by TEXT,
  claimed_at TEXT,
  parent_id  INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  -- servant's own extensions, and only servant's: agent-kanban splits this into a system-owned
  -- column and a consumer-owned one, and we deliberately expose only the latter.
  input      TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (board_id, seq)
);

CREATE TABLE ticket_dependencies (
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  depends_on INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, depends_on),
  CHECK (ticket_id <> depends_on)
);

CREATE INDEX ticket_dependencies_reverse ON ticket_dependencies (depends_on);

-- Append-only. Claims, transfers, releases, comments and status changes are all rows here, which
-- is what makes a transfer auditable rather than a field that was overwritten.
CREATE TABLE ticket_actions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor     TEXT NOT NULL,
  session   TEXT,
  kind      TEXT NOT NULL,
  body      TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL
);

CREATE INDEX ticket_actions_ticket ON ticket_actions (ticket_id, id);

-- A projection of what the session registry said, refreshed opportunistically. Never the
-- authority on liveness (ADR-0011 decision 3) — that stays a PID check.
CREATE TABLE sessions (
  name      TEXT PRIMARY KEY,
  pid       INTEGER,
  last_seen TEXT NOT NULL
);
`;

// An action's identity in whatever system it came from — a hub comment's GitHub id, and nothing
// else so far. Unique so that carrying the same comment twice is refused by the database rather
// than by a read-then-write the importer would have to get right; NULLs stay distinct in SQLite, so
// the actions servant writes itself are unconstrained.
const ADD_EXTERNAL_ID = `
ALTER TABLE ticket_actions ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX ticket_actions_external ON ticket_actions (external_id);
`;

/** One step per schema version, applied in order. Index N takes the board from version N to N+1. */
const MIGRATIONS: readonly string[] = [SCHEMA, ADD_EXTERNAL_ID];

let cached: { path: string; db: Database } | null = null;

function migrate(db: Database): void {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const from = row?.user_version ?? 0;
  if (from >= SCHEMA_VERSION) return;
  db.transaction(() => {
    for (const step of MIGRATIONS.slice(from, SCHEMA_VERSION)) db.run(step);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

/**
 * The open board, created on first use. Keyed on the resolved path so a `--root` override (or a
 * test pointing at a temp dir) opens its own database rather than inheriting an earlier one.
 */
export function openBoard(): Database {
  const path = boardDbPath();
  if (cached?.path === path) return cached.db;
  cached?.db.close();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  cached = { path, db };
  return db;
}

/** Release the handle. Tests call this between temp roots; commands never need to. */
export function closeBoard(): void {
  cached?.db.close();
  cached = null;
}
