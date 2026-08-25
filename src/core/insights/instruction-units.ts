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
//
// A doc that servant generates into is more than one unit, and is split accordingly — see
// `splitGeneratedRegions`.

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
  /**
   * Mechanical uses: Skill/slash-command invocations for a skill; for a doc, every way a session
   * went and read it — the `Read` tool *and* read-shaped Bash (`cat`, `sed -n`, `grep`), which is
   * how docs are actually read and therefore the only way this is ever non-zero.
   */
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

/** One slice of an instruction doc: its authored text, or one region servant generates into it. */
export interface DocRegion {
  /** The region's marker name (`knowledge`), or null for the doc's own authored text. */
  name: string | null;
  chars: number;
}

/**
 * A generated region announces itself: its opening marker says edits *below* it are overwritten,
 * and it runs to the next such marker or to EOF. A whole-file stamp says edits *here* are
 * overwritten and is deliberately not a boundary — it describes the file, not a region inside it.
 */
const GENERATED_REGION_RE =
  /^<!--[ \t]*servant:([a-z0-9-]+)\b.*edits below are overwritten.*-->[ \t]*$/gim;

/**
 * Split a doc into the text a human tunes and the regions servant renders into it.
 *
 * The split exists because a single verdict on a mixed doc says the wrong thing. Measured on this
 * workspace, `ws:CLAUDE.md` scored 7/7 justified and every stated reason cited the 279 tokens of
 * board conventions — while 6,793 tokens of generated knowledge index rode along unmentioned. The
 * two halves also have different levers: prose is tuned through the fine-tune overlay, a generated
 * region only by changing what renders it.
 *
 * The marker is the only thing read here, never a renderer's name, which keeps this module as
 * ignorant of specific units as the rest of servant is: the next block that declares itself
 * overwritable splits out without this file learning anything.
 *
 * A marker that does *not* declare it (`<!-- servant:agent-skills -->`) stays charged to the
 * authored text on purpose — it anchors a section of servant's own prose, and prose is prose
 * whoever typed it. The split tracks levers, not authorship.
 */
export function splitGeneratedRegions(text: string): DocRegion[] {
  const marks: { name: string; start: number }[] = [];
  for (const m of text.matchAll(GENERATED_REGION_RE)) {
    if (m.index !== undefined && m[1]) marks.push({ name: m[1], start: m.index });
  }
  if (marks.length === 0) return [{ name: null, chars: text.length }];
  const byName = new Map<string, number>();
  for (const [i, mark] of marks.entries()) {
    const end = marks[i + 1]?.start ?? text.length;
    byName.set(mark.name, (byName.get(mark.name) ?? 0) + (end - mark.start));
  }
  return [
    { name: null, chars: marks[0]?.start ?? 0 },
    ...[...byName].map(([name, chars]) => ({ name, chars })),
  ];
}

/** A generated region's unit id, namespaced under the doc it lives in. */
export function regionUnitId(docId: string, region: string): string {
  return `${docId}#${region}`;
}

/** The inverse: the doc and region a unit id names, or null when it is not a region id. */
export function parseRegionUnitId(id: string): { docId: string; region: string } | null {
  const at = id.indexOf("#");
  return at > 0 ? { docId: id.slice(0, at), region: id.slice(at + 1) } : null;
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
  /** The authored text plus every generated region, authored first. */
  regions: DocRegion[];
  resident: boolean;
}

async function docRegions(path: string): Promise<DocRegion[] | null> {
  try {
    return splitGeneratedRegions(await readFile(path, "utf8"));
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
  const rootRegions = await docRegions(rootConventions);
  if (rootRegions) {
    out.push({ id: "root:CLAUDE.md", path: rootConventions, regions: rootRegions, resident: true });
  }
  if (!workspace) return out;

  const wsDir = workspacePath(workspace);
  const backend = await readWorkspaceAgent(workspace);
  const rendering = backend === "codex" ? "AGENTS.md" : "CLAUDE.md";
  for (const rel of [rendering, "GOAL.md"]) {
    const path = join(wsDir, rel);
    const regions = await docRegions(path);
    if (regions) out.push({ id: `ws:${rel}`, path, regions, resident: true });
  }
  for (const rel of ON_DEMAND_DOC_FILES) {
    const path = join(wsDir, rel);
    const regions = await docRegions(path);
    if (regions) out.push({ id: `ws:${rel}`, path, regions, resident: false });
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
      const regions = await docRegions(path);
      if (regions) out.push({ id: `ws:${rel}`, path, regions, resident: false });
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
  /**
   * Absolute path → read-shaped Bash count (`cat`, `sed -n`, `grep`). Kept separate from
   * `readCounts` on the way in because only the doc join wants it: the `Read`-tool map also feeds
   * the repeated-read friction signal, and every `cat` in a session is not that.
   */
  bashReadCounts?: ReadonlyMap<string, number>;
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
  // Split so a verdict lands on the half it can actually act on.
  const regionsOf = new Map<string, string[]>();
  for (const d of enumerated) {
    for (const region of d.regions) {
      const id = region.name === null ? d.id : regionUnitId(d.id, region.name);
      if (id !== d.id) {
        const siblings = regionsOf.get(d.id);
        if (siblings) siblings.push(id);
        else regionsOf.set(d.id, [id]);
      }
      set({
        id,
        kind: "doc",
        approxTokens: approxTokens(region.chars),
        resident: d.resident,
        fromStart: true,
        uses: 0,
      });
    }
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
  // Reading a file reads everything in it, so a doc's regions count the read too.
  const countRead = (path: string, count: number) => {
    const id = docIdForPath(path, wsDir);
    if (!id) return;
    for (const target of [id, ...(regionsOf.get(id) ?? [])]) {
      const unit = units.get(target);
      if (unit) unit.uses += count;
    }
  };
  for (const [path, count] of opts.readCounts) countRead(path, count);
  for (const [path, count] of opts.bashReadCounts ?? []) countRead(path, count);

  return [...units.values()]
    .toSorted((a, b) => b.approxTokens - a.approxTokens || a.id.localeCompare(b.id))
    .slice(0, opts.maxUnits ?? DEFAULT_MAX_UNITS);
}
