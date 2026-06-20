import { existsSync } from "node:fs";
import { type Confidence, listAllNotes, projectOfScope } from "../knowledge.ts";

// A one-shot health scan over the knowledge store itself (not transcripts): is the base
// high-quality, fresh, and actually used? "Dead notes" need cross-transcript usage, so the caller
// passes in the set of note files ever recalled/read (gathered from the session metrics records).

const STALE_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 6 months

export interface KnowledgeHealth {
  totalNotes: number;
  byScope: { topic: number; project: number };
  byRepo: { repo: string; count: number }[];
  confidence: Record<Confidence, number>;
  /** Notes whose source.date is older than the staleness window. */
  stale: { name: string; path: string; date: string }[];
  /** Notes whose body cites a file path that no longer exists on disk. */
  rotted: { name: string; path: string; missing: string }[];
  /** Topic tags used by exactly one note. */
  orphanTags: string[];
  /** Notes never recalled/read across all scanned transcripts. */
  dead: { name: string; path: string }[];
}

// A path-like token in a note body: a relative or absolute path with a file extension.
const PATH_CITATION_RE =
  /(?:^|[\s(`"'])((?:\/|\.\.?\/|[\w.-]+\/)[\w./-]+\.[a-z]{1,5})(?=[\s)`"':,.]|$)/gi;

function parseDate(date: string | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : t;
}

function citedPaths(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  PATH_CITATION_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = PATH_CITATION_RE.exec(body)) !== null) {
    const p = m[1];
    if (p) out.add(p);
  }
  return [...out];
}

/**
 * Scan the knowledge store for health signals. `readNoteFiles` is the set of knowledge note file
 * paths that were ever recalled/read (from the transcripts) — used to flag dead notes. `now` is
 * injectable for deterministic tests.
 */
export async function scanKnowledgeHealth(
  opts: {
    readNoteFiles?: ReadonlySet<string>;
    now?: number;
  } = {},
): Promise<KnowledgeHealth> {
  const now = opts.now ?? Date.now();
  const readSet = opts.readNoteFiles ?? new Set<string>();
  const stored = await listAllNotes();

  const byScope = { topic: 0, project: 0 };
  const repoCounts = new Map<string, number>();
  const confidence: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  const tagCounts = new Map<string, number>();
  const stale: KnowledgeHealth["stale"] = [];
  const rotted: KnowledgeHealth["rotted"] = [];
  const dead: KnowledgeHealth["dead"] = [];

  for (const { note, path } of stored) {
    const repo = projectOfScope(note.scope);
    if (repo) {
      byScope.project += 1;
      repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
    } else {
      byScope.topic += 1;
      for (const tag of note.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    confidence[note.confidence] = (confidence[note.confidence] ?? 0) + 1;

    const ts = parseDate(note.source.date);
    if (ts !== null && now - ts > STALE_AGE_MS) {
      stale.push({ name: note.name, path, date: note.source.date ?? "" });
    }

    for (const cited of citedPaths(note.body)) {
      // Only check paths that look resolvable (absolute or workspace-relative repo paths).
      if (cited.startsWith("/") && !existsSync(cited)) {
        rotted.push({ name: note.name, path, missing: cited });
        break;
      }
    }

    if (!readSet.has(path)) dead.push({ name: note.name, path });
  }

  const orphanTags = [...tagCounts.entries()]
    .filter(([, c]) => c === 1)
    .map(([tag]) => tag)
    .toSorted();

  return {
    totalNotes: stored.length,
    byScope,
    byRepo: [...repoCounts.entries()]
      .map(([repo, count]) => ({ repo, count }))
      .toSorted((a, b) => b.count - a.count || a.repo.localeCompare(b.repo)),
    confidence,
    stale,
    rotted,
    orphanTags,
    dead,
  };
}

/**
 * Convenience: flatten per-session note-path lists into one set of "used" note files. Callers pass
 * the union of notes Read and notes a `servant recall` surfaced inline, so the dead-note scan treats
 * recall-surfaced notes as live (not just `Read` ones).
 */
export function readNoteFilesFrom(usedNotesPerSession: readonly string[][]): Set<string> {
  const out = new Set<string>();
  for (const used of usedNotesPerSession) for (const p of used) out.add(p);
  return out;
}
