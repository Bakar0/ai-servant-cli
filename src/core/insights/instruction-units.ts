import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { aiServantRoot, workspacePath } from "../paths.ts";
import { readWorkspaceAgent } from "../workspace.ts";

// An **instruction unit** is anything loaded into a session to shape it: a skill or an agent
// instruction document. Both are judged by the same question — was this loaded, and was it worth it
// — which is what makes a 10 KB CLAUDE.md answerable with data rather than taste.
//
// This module owns the deterministic half of that question: which units a session ran with, what
// each one cost, and how often it was mechanically used. The qualitative half (earned / wasted)
// lives in `judgments.ts`, and any aggregate across sessions is computed on read (`unit-scores.ts`).
//
// Two sources, because neither alone is complete:
//   - The transcript records the skill set as `skill_listing` attachments (names + the description
//     text Claude Code keeps resident in context) and repo CLAUDE.md/AGENTS.md as `nested_memory`.
//   - The top-level instruction docs — servant's root conventions, the workspace rendering, GOAL.md
//     — live only in the unrecorded system prompt, so they are enumerated from disk the same way
//     the setup fingerprint enumerates its parts when the transcript did not embed them.

export type InstructionUnitKind = "skill" | "doc";

/** One instruction unit a session ran with, with everything mechanically knowable about it. */
export interface InstructionUnit {
  /** Stable identity across sessions: a skill's invocation name, or a namespaced doc path. */
  id: string;
  kind: InstructionUnitKind;
  /** Approx tokens of text this unit is worth — a skill's description, a doc's body. */
  approxTokens: number;
  /**
   * True when the text sits in context every turn whether or not it is used (a skill description,
   * an auto-loaded doc). False for a doc that costs nothing until something reads it.
   */
  resident: boolean;
  /**
   * True when the unit was in the session's *starting* set. A skill disabled mid-session still cost
   * that session its resident description — Claude Code never retracts one — so the starting set,
   * not the ending one, is what a per-session verdict is about.
   */
  fromStart: boolean;
  /** Mechanical uses: Skill/slash-command invocations for a skill, `Read` calls for a doc. */
  uses: number;
}

/** Cap on units per session record — above a full instruction surface, so it never bites in practice. */
const DEFAULT_MAX_UNITS = 120;

const APPROX_CHARS_PER_TOKEN = 4;
const approxTokens = (chars: number): number => Math.round(chars / APPROX_CHARS_PER_TOKEN);

/** The subset of a transcript record this module reads. */
export interface UnitRecord {
  attachment?: unknown;
}

/** The on-demand board/domain docs a workspace publishes — read when needed, not resident. */
const ON_DEMAND_DOC_DIRS = ["docs/agents"] as const;
const ON_DEMAND_DOC_FILES = ["CONTEXT.md"] as const;

/**
 * Strip an invocation to the name a unit is keyed by: `/servant-lead` and `servant-lead` are the
 * same unit, whether the session reached it through the Skill tool or a slash command.
 */
export function normalizeInvocationName(raw: string): string {
  return raw.trim().replace(/^\/+/, "");
}

interface ListedSkill {
  name: string;
  chars: number;
  fromStart: boolean;
}

/**
 * Split a skill listing into per-skill description sizes. Each entry starts a line as
 * `- <name>: <description>`; the description may wrap over following lines, which belong to the
 * entry above them. Returns chars per name so a skill's resident cost is attributable to it.
 */
export function parseSkillListing(content: string): Map<string, number> {
  const out = new Map<string, number>();
  let current: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const head = /^- ([^:\n]+(?::[^:\s][^:\n]*)?):\s/.exec(line);
    if (head?.[1]) {
      current = head[1].trim();
      out.set(current, (out.get(current) ?? 0) + line.length + 1);
      continue;
    }
    if (current) out.set(current, (out.get(current) ?? 0) + line.length + 1);
  }
  return out;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A `nested_memory` attachment carries its doc body either inline or wrapped in an object. */
function nestedMemoryBody(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const inner = (content as { content?: unknown }).content;
    if (typeof inner === "string") return inner;
  }
  return "";
}

interface AttachmentUnits {
  skills: ListedSkill[];
  docs: { path: string; chars: number }[];
}

/**
 * The units the transcript records for itself: every `skill_listing` (the initial one is the
 * session's starting set; later ones are mid-session additions) and every `nested_memory` doc.
 * Union rather than last-wins — a skill listed once was resident from then on.
 */
export function unitsFromRecords(records: readonly UnitRecord[]): AttachmentUnits {
  const skillChars = new Map<string, number>();
  const skillFromStart = new Map<string, boolean>();
  const docChars = new Map<string, number>();

  for (const rec of records) {
    const a = rec.attachment;
    if (!a || typeof a !== "object") continue;
    const att = a as {
      type?: unknown;
      names?: unknown;
      content?: unknown;
      isInitial?: unknown;
      skillNames?: unknown;
      path?: unknown;
    };
    if (att.type === "skill_listing" || att.type === "dynamic_skill") {
      const perName =
        typeof att.content === "string"
          ? parseSkillListing(att.content)
          : new Map<string, number>();
      const listed = asStringArray(att.names ?? att.skillNames);
      const names = listed.length > 0 ? listed : [...perName.keys()];
      const initial = att.isInitial === true;
      for (const name of names) {
        skillChars.set(name, Math.max(skillChars.get(name) ?? 0, perName.get(name) ?? 0));
        if (initial) skillFromStart.set(name, true);
        else if (!skillFromStart.has(name)) skillFromStart.set(name, false);
      }
      continue;
    }
    if (att.type === "nested_memory" && typeof att.path === "string" && att.path) {
      const body = nestedMemoryBody(att.content);
      docChars.set(att.path, Math.max(docChars.get(att.path) ?? 0, body.length));
    }
  }

  return {
    skills: [...skillChars.entries()].map(([name, chars]) => ({
      name,
      chars,
      fromStart: skillFromStart.get(name) === true,
    })),
    docs: [...docChars.entries()].map(([path, chars]) => ({ path, chars })),
  };
}

interface EnumeratedDoc {
  id: string;
  path: string;
  chars: number;
  resident: boolean;
}

async function fileChars(path: string): Promise<number | null> {
  try {
    return (await readFile(path, "utf8")).length;
  } catch {
    return null;
  }
}

/**
 * The instruction docs the system prompt loads, which the transcript never records: servant's root
 * conventions, the workspace's own rendering for the backend driving it, and its GOAL.md — plus the
 * on-demand board contract, which costs nothing until a session reads it.
 *
 * Only the rendering the session's backend actually loads is emitted (CLAUDE.md for Claude,
 * AGENTS.md for Codex), so the other backend's twin never reads as a unit nobody used.
 */
export async function enumerateDocUnits(workspace: string | null): Promise<EnumeratedDoc[]> {
  const out: EnumeratedDoc[] = [];
  const rootConventions = join(aiServantRoot(), "CLAUDE.md");
  const rootChars = await fileChars(rootConventions);
  if (rootChars !== null) {
    out.push({ id: "root:CLAUDE.md", path: rootConventions, chars: rootChars, resident: true });
  }
  if (!workspace) return out;

  const wsDir = workspacePath(workspace);
  const backend = await readWorkspaceAgent(workspace);
  const rendering = backend === "codex" ? "AGENTS.md" : "CLAUDE.md";
  for (const rel of [rendering, "GOAL.md"]) {
    const path = join(wsDir, rel);
    const chars = await fileChars(path);
    if (chars !== null) out.push({ id: `ws:${rel}`, path, chars, resident: true });
  }
  for (const rel of ON_DEMAND_DOC_FILES) {
    const path = join(wsDir, rel);
    const chars = await fileChars(path);
    if (chars !== null) out.push({ id: `ws:${rel}`, path, chars, resident: false });
  }
  for (const dir of ON_DEMAND_DOC_DIRS) {
    let names: string[] = [];
    try {
      names = (await readdir(join(wsDir, dir))).filter((n) => n.endsWith(".md"));
    } catch {
      continue; // workspace predates the doc surface
    }
    for (const name of names.toSorted()) {
      const rel = `${dir}/${name}`;
      const path = join(wsDir, rel);
      const chars = await fileChars(path);
      if (chars !== null) out.push({ id: `ws:${rel}`, path, chars, resident: false });
    }
  }
  return out;
}

/**
 * Attribute an invocation to a unit id. Exact match first; a bare name also resolves to a single
 * namespaced skill (`tdd` → `mattpocock-skills:tdd`) but never to an ambiguous set of them.
 */
function resolveInvocation(name: string, ids: readonly string[]): string | null {
  if (ids.includes(name)) return name;
  const suffixed = ids.filter((id) => id.endsWith(`:${name}`));
  return suffixed.length === 1 ? (suffixed[0] ?? null) : null;
}

/** Path → its workspace-relative unit id, for joining `Read` calls to enumerated doc units. */
function docIdForPath(path: string, wsDir: string | null): string | null {
  if (!wsDir || !isAbsolute(path)) return null;
  const rel = relative(resolve(wsDir), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return `ws:${rel.split(sep).join("/")}`;
}

/**
 * The session's full instruction-unit inventory: what it ran with, what each unit cost, and how
 * often it was used. Deterministic — same transcript and same instruction surface, same list.
 */
export async function collectInstructionUnits(opts: {
  records: readonly UnitRecord[];
  /** Every skill/slash invocation observed, in transcript order (repeats included). */
  invocations: readonly string[];
  /** Absolute path → `Read` count, for joining reads to doc units. */
  readCounts: ReadonlyMap<string, number>;
  workspace: string | null;
  maxUnits?: number;
}): Promise<InstructionUnit[]> {
  const { skills, docs } = unitsFromRecords(opts.records);
  const enumerated = await enumerateDocUnits(opts.workspace);
  const wsDir = opts.workspace ? workspacePath(opts.workspace) : null;

  const units = new Map<string, InstructionUnit>();
  const set = (u: InstructionUnit) => units.set(u.id, u);

  for (const s of skills) {
    set({
      id: s.name,
      kind: "skill",
      approxTokens: approxTokens(s.chars),
      resident: true,
      fromStart: s.fromStart,
      uses: 0,
    });
  }
  for (const d of enumerated) {
    set({
      id: d.id,
      kind: "doc",
      approxTokens: approxTokens(d.chars),
      resident: d.resident,
      fromStart: true,
      uses: 0,
    });
  }
  // Repo-level CLAUDE.md/AGENTS.md files load when the session touches their directory, so they are
  // resident from that point on but not part of the starting set.
  for (const d of docs) {
    const id = docIdForPath(d.path, wsDir) ?? `doc:${d.path}`;
    if (units.has(id)) continue;
    set({
      id,
      kind: "doc",
      approxTokens: approxTokens(d.chars),
      resident: true,
      fromStart: false,
      uses: 0,
    });
  }

  const skillIds = [...units.values()].filter((u) => u.kind === "skill").map((u) => u.id);
  for (const raw of opts.invocations) {
    const id = resolveInvocation(normalizeInvocationName(raw), skillIds);
    const unit = id ? units.get(id) : undefined;
    if (unit) unit.uses += 1;
  }
  for (const [path, count] of opts.readCounts) {
    const id = docIdForPath(path, wsDir);
    const unit = id ? units.get(id) : undefined;
    if (unit) unit.uses += count;
  }

  return [...units.values()]
    .toSorted((a, b) => b.approxTokens - a.approxTokens || a.id.localeCompare(b.id))
    .slice(0, opts.maxUnits ?? DEFAULT_MAX_UNITS);
}
