import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePath } from "../paths.ts";

// The workspace-artifact parsing layer for the dashboard. Pure markdown readers over a workspace's
// GOAL.md and plans/INDEX (+ plan bodies) that return the typed structures the trimmed payload hangs
// its two artifact-backed panels on — Mission (GOAL.md) and Where-we-are (plan phases). Every parser
// degrades to an empty-but-valid result on a missing or malformed file — never throws — so one broken
// artifact yields an empty panel, not a broken dashboard.

/** The status bucket a freeform `[status: …]` tag normalizes to (the D2 grammar). */
export type StatusBucket =
  | "done"
  | "in-progress"
  | "blocked"
  | "abandoned"
  | "superseded"
  | "reversed"
  | "todo"
  | "unknown";

/** A plan phase's progress, derived from done/active markers near its id. */
export type PhaseState = "done" | "active" | "remaining";

export interface Goal {
  mission: string;
}

export interface PlanPhase {
  id: string;
  state: PhaseState;
  /** Human label parsed from a `**P# — Label**` build-phase heading, when the plan body carries one. */
  label?: string;
}

export interface PlanItem {
  id: string;
  title: string;
  summary: string;
  status: StatusBucket;
  statusText: string;
  phases: PlanPhase[];
  doneCount: number;
  totalCount: number;
}

// ── Status normalization (the D2 contract) ──────────────────────────────────────────────────────

/**
 * Map a freeform status string to a bucket by its **leading status token** — the bucket word at the
 * very start of the text, before any separator (`—`, `–`, `-`, `:`) or trailing prose. A real tag
 * carries long detail after that word (`done — …a ledger of abandoned/reversed/superseded items…`),
 * so a whole-string keyword scan would mis-bucket it; anchoring to the start ignores the detail.
 * Only when the leading token matches no known bucket do we fall back to `unknown` — never to a
 * keyword buried in the trailing prose.
 */
const STATUS_PREFIXES: ReadonlyArray<readonly [RegExp, StatusBucket]> = [
  [/^abandoned\b/, "abandoned"],
  [/^blocked\b/, "blocked"],
  [/^superseded\b/, "superseded"],
  [/^reversed\b/, "reversed"],
  [/^(?:done|shipped)\b/, "done"],
  [/^(?:in[- ]progress|wip)\b/, "in-progress"],
  [/^(?:proposed|pending)\b/, "todo"],
];

export function normalizeStatus(text: string): StatusBucket {
  const t = (text ?? "").toLowerCase().replace(/^[\s>*_]+/, "");
  for (const [re, bucket] of STATUS_PREFIXES) {
    if (re.test(t)) return bucket;
  }
  return "unknown";
}

// ── Small text helpers ──────────────────────────────────────────────────────────────────────────

/** Turn a `YYYY-MM-DD-HHMM-some-slug(.md)` link into readable words. */
function humanizeSlug(linkText: string): string {
  return linkText
    .replace(/\.md$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-\d{3,4}-/, "")
    .replace(/-/g, " ")
    .trim();
}

/** Flatten inline markdown (links→text, drop emphasis/blockquote markers, collapse whitespace). */
function cleanInline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\n[\s>]*/g, " ")
    .replace(/^[\s>]+|[\s>]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedBullet {
  id: string;
  target: string;
  title: string;
  summary: string;
  statusText: string;
}

/**
 * Parse the `- [text](target) … [status: …] …` bullets of an INDEX file. Tolerant of the two real
 * orderings (the status last vs. right after the link) by extracting the `[status: …]` chunk wherever
 * it sits and treating the remainder as the summary.
 */
function parseIndexBullets(md: string): ParsedBullet[] {
  const out: ParsedBullet[] = [];
  for (const line of md.split("\n")) {
    const m = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/.exec(line);
    if (!m) continue;
    const linkText = m[1] ?? "";
    const target = m[2] ?? "";
    let rest = m[3] ?? "";
    let statusText = "";
    const sm = /\[status:\s*([\s\S]*?)\]/i.exec(rest);
    if (sm) {
      statusText = (sm[1] ?? "").trim();
      rest = rest.replace(sm[0], "");
    }
    const summary = rest
      .replace(/^[\s—–-]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ id: linkText, target, title: humanizeSlug(linkText), summary, statusText });
  }
  return out;
}

// ── GOAL.md ───────────────────────────────────────────────────────────────────────────────────

/** Pure parser for GOAL.md text — extracts the one-line `## Mission` (read-only; GOAL.md is never written). */
export function parseGoalText(text: string): Goal {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && /mission/i.test(l));
  if (start < 0) return { mission: "" };
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) break;
    body.push(lines[i] ?? "");
  }
  const mission = cleanInline(
    body
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" "),
  )
    .replace(/servant:goal:unfilled/gi, "")
    .trim();
  return { mission };
}

// ── plans/INDEX.md + plan bodies ────────────────────────────────────────────────────────────────

const PHASE_ID = /\bP(\d+[a-z]?)\b/g;

/** Classify a clause/line: does it carry a done or active marker? */
function markerState(s: string): PhaseState | null {
  if (/✅|✓|\bdone\b|\bshipped\b|\bcomplete[d]?\b|\bmerged\b/i.test(s)) return "done";
  if (/\bactive\b|in[- ]progress|in progress|\bwip\b|\bcurrent\b/i.test(s)) return "active";
  return null;
}

/**
 * Derive a plan's phases from its INDEX status text plus its body. Phase ids are collected in first-
 * appearance order across both. A phase's state comes from done/active markers found either on a
 * line carrying that single id (long build-phase bullets) or in a comma/arrow-delimited clause that
 * mentions it (compact `P0/P1 done` status tags). Absent any marker, a phase is `remaining`.
 */
export function derivePlanPhases(statusText: string, bodyText: string): PlanPhase[] {
  const text = `${statusText}\n${bodyText}`;

  const order: string[] = [];
  for (const m of text.matchAll(PHASE_ID)) {
    const id = `P${m[1]}`;
    if (!order.includes(id)) order.push(id);
  }
  if (order.length === 0) return [];

  const RANK: Record<PhaseState, number> = { remaining: 1, active: 2, done: 3 };
  const strength: Record<string, number> = {};
  const upgrade = (id: string, state: PhaseState) => {
    if ((strength[id] ?? 0) < RANK[state]) strength[id] = RANK[state];
  };

  // Line-level: a marker on a line with exactly one phase id binds to that id.
  for (const line of text.split("\n")) {
    const ids = [...new Set([...line.matchAll(PHASE_ID)].map((m) => `P${m[1]}`))];
    const state = markerState(line);
    if (state && ids.length === 1) upgrade(ids[0] as string, state);
  }
  // Clause-level: split compact text so a shared marker reaches every id in its clause.
  for (const clause of text.split(/[,;.\n]|→|->/)) {
    const state = markerState(clause);
    if (!state) continue;
    for (const m of clause.matchAll(PHASE_ID)) upgrade(`P${m[1]}`, state);
  }

  // Per-phase human labels from the canonical `**P# — Label**` build-phase headings (first one wins).
  const labels: Record<string, string> = {};
  for (const m of text.matchAll(/\*\*\s*P(\d+[a-z]?)\s*[—–-]\s*([^*]+?)\s*\*\*/g)) {
    const id = `P${m[1]}`;
    if (labels[id]) continue;
    const label = (m[2] ?? "")
      .replace(/\s+/g, " ")
      .replace(/[.\s]+$/, "")
      .trim();
    if (label) labels[id] = label;
  }

  return order.map((id) => {
    const rank = strength[id] ?? 1;
    const state: PhaseState = rank === 3 ? "done" : rank === 2 ? "active" : "remaining";
    const label = labels[id];
    return label ? { id, state, label } : { id, state };
  });
}

/** Pure parser for plans/INDEX.md; `readBody(target)` supplies each plan's body for phase parsing. */
export function parsePlansText(
  indexMd: string,
  readBody: (target: string) => string | null,
): PlanItem[] {
  return parseIndexBullets(indexMd).map((b) => {
    const phases = derivePlanPhases(b.statusText, readBody(b.target) ?? "");
    return {
      id: b.id,
      title: b.title,
      summary: b.summary,
      status: normalizeStatus(b.statusText),
      statusText: b.statusText,
      phases,
      doneCount: phases.filter((p) => p.state === "done").length,
      totalCount: phases.length,
    };
  });
}

// ── Disk-backed parsers (resolve a workspace's paths, degrade to empty) ───────────────────────────

function readOr(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function parseGoal(workspace: string): Goal {
  const txt = readOr(join(workspacePath(workspace), "GOAL.md"));
  return txt ? parseGoalText(txt) : { mission: "" };
}

export function parsePlans(workspace: string): PlanItem[] {
  const dir = join(workspacePath(workspace), "plans");
  const idx = readOr(join(dir, "INDEX.md"));
  return idx ? parsePlansText(idx, (target) => readOr(join(dir, target))) : [];
}
