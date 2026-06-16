import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import {
  knowledgeIndexPath,
  knowledgeProjectDir,
  knowledgeProjectIndexPath,
  knowledgeProjectsDir,
  knowledgeRoot,
  knowledgeTopicsDir,
} from "./paths.ts";

// One atomic fact per file, cloning the proven Claude Code memory format: YAML
// frontmatter + a markdown body. Project facts live in projects/<repo>/<slug>.md
// (with a per-dir INDEX.md); topic facts live flat in topics/<slug>.md and carry
// tags that drive ripgrep-style retrieval. The master INDEX.md is thin: it links to
// each per-repo index and lists the topic tag vocabulary — never every note.

export type NoteScope = "topic" | `project/${string}`;
export type Confidence = "high" | "medium" | "low";

export interface NoteSource {
  session?: string;
  date?: string;
  commit?: string;
}

export interface KnowledgeNote {
  /** kebab-case slug; unique within its project dir (projects) or topics/. */
  name: string;
  /** one-line summary — what the index/recall surfaces to decide relevance. */
  description: string;
  /** "topic" or "project/<repo>". */
  scope: NoteScope;
  /** topics only; drives retrieval. */
  tags: string[];
  source: NoteSource;
  confidence: Confidence;
  /** markdown body (everything after the frontmatter). */
  body: string;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function assertValidSlug(name: string): void {
  if (!SLUG_RE.test(name)) {
    throw new Error(`Invalid note name "${name}" — must be a kebab-case slug.`);
  }
}

/** The repo name for a project-scoped note, or null for topics. */
export function projectOfScope(scope: NoteScope): string | null {
  return scope.startsWith("project/") ? scope.slice("project/".length) : null;
}

/** Absolute path of the note file for a given name+scope (dedup key → file path). */
export function noteFilePath(scope: NoteScope, name: string): string {
  const repo = projectOfScope(scope);
  if (repo) return join(knowledgeProjectDir(repo), `${name}.md`);
  return join(knowledgeTopicsDir(), `${name}.md`);
}

// --- Frontmatter (a deliberately small YAML subset; we own the writer) ---

function serializeInlineList(items: string[]): string {
  return `[${items.join(", ")}]`;
}

function serializeSource(source: NoteSource): string {
  const parts: string[] = [];
  if (source.session) parts.push(`session: ${source.session}`);
  if (source.date) parts.push(`date: ${source.date}`);
  if (source.commit) parts.push(`commit: ${source.commit}`);
  return `{ ${parts.join(", ")} }`;
}

export function serializeNote(note: KnowledgeNote): string {
  assertValidSlug(note.name);
  const lines = [
    "---",
    `name: ${note.name}`,
    `description: ${note.description}`,
    `scope: ${note.scope}`,
  ];
  if (note.tags.length > 0 || note.scope === "topic") {
    lines.push(`tags: ${serializeInlineList(note.tags)}`);
  }
  lines.push(`source: ${serializeSource(note.source)}`);
  lines.push(`confidence: ${note.confidence}`);
  lines.push("---");
  const body = note.body.trimEnd();
  return `${lines.join("\n")}\n${body ? `${body}\n` : ""}`;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseInlineObject(value: string): Record<string, string> {
  const trimmed = value.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Record<string, string> = {};
  for (const pair of trimmed.split(",")) {
    const idx = pair.indexOf(":");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

export function parseNote(text: string): KnowledgeNote {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("Note is missing YAML frontmatter.");
  const [, front, body] = match;
  const fields: Record<string, string> = {};
  for (const line of (front ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) fields[key] = val;
  }
  const name = fields.name ?? "";
  const scope = (fields.scope ?? "topic") as NoteScope;
  const confidence = (fields.confidence ?? "medium") as Confidence;
  return {
    name,
    description: fields.description ?? "",
    scope,
    tags: fields.tags ? parseInlineList(fields.tags) : [],
    source: fields.source ? (parseInlineObject(fields.source) as NoteSource) : {},
    confidence,
    body: (body ?? "").trimEnd(),
  };
}

// --- Store lifecycle ---

async function gitInitialized(): Promise<boolean> {
  return existsSync(join(knowledgeRoot(), ".git"));
}

/** Create the store dirs and git-init on first use. Idempotent and cheap. */
export async function ensureKnowledgeStore(): Promise<void> {
  await mkdir(knowledgeProjectsDir(), { recursive: true });
  await mkdir(knowledgeTopicsDir(), { recursive: true });
  if (!(await gitInitialized())) {
    await $`git -C ${knowledgeRoot()} init -q`.nothrow().quiet();
  }
  if (!existsSync(knowledgeIndexPath())) {
    await rebuildMasterIndex();
  }
}

// Identity flags passed per-commit so a freshly `git init`-ed store commits even when
// the user has no global git identity. -c flags don't touch the user's git config.
const GIT_IDENTITY = ["-c", "user.name=servant", "-c", "user.email=servant@localhost"];

/** Stage everything under knowledge/ and commit. No-op if nothing changed. */
export async function commitKnowledge(message: string): Promise<void> {
  const root = knowledgeRoot();
  if (!(await gitInitialized())) return;
  await $`git -C ${root} add -A`.nothrow().quiet();
  const status = await $`git -C ${root} status --porcelain`.nothrow().quiet();
  if (status.stdout.toString().trim() === "") return;
  await $`git -C ${root} ${GIT_IDENTITY} commit -q -m ${message}`.nothrow().quiet();
}

// --- Note read/write + dedup ---

/**
 * Write a note to its name+scope path (the dedup key). Reconciles the relevant
 * indexes. Returns whether the note was newly created or updated in place.
 */
export async function upsertNote(note: KnowledgeNote): Promise<"created" | "updated"> {
  assertValidSlug(note.name);
  await ensureKnowledgeStore();
  const path = noteFilePath(note.scope, note.name);
  const result = existsSync(path) ? "updated" : "created";
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, serializeNote(note));
  const repo = projectOfScope(note.scope);
  if (repo) await rebuildProjectIndex(repo);
  await rebuildMasterIndex();
  return result;
}

export async function readNoteFile(path: string): Promise<KnowledgeNote | null> {
  try {
    return parseNote(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries.filter((n) => n.endsWith(".md") && n !== "INDEX.md").map((n) => join(dir, n));
}

export async function listProjectRepos(): Promise<string[]> {
  const dir = knowledgeProjectsDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export async function readProjectNotes(repo: string): Promise<KnowledgeNote[]> {
  const paths = await listMarkdown(knowledgeProjectDir(repo));
  const notes: KnowledgeNote[] = [];
  for (const p of paths) {
    const note = await readNoteFile(p);
    if (note) notes.push(note);
  }
  return notes;
}

export async function readTopicNotes(): Promise<KnowledgeNote[]> {
  const paths = await listMarkdown(knowledgeTopicsDir());
  const notes: KnowledgeNote[] = [];
  for (const p of paths) {
    const note = await readNoteFile(p);
    if (note) notes.push(note);
  }
  return notes;
}

// --- Index reconcile ---

function indexLine(note: KnowledgeNote): string {
  return `- [${note.name}](${note.name}.md) — ${note.description}`;
}

/** Rebuild projects/<repo>/INDEX.md from the notes on disk. Creates an empty index too. */
export async function rebuildProjectIndex(repo: string): Promise<void> {
  await mkdir(knowledgeProjectDir(repo), { recursive: true });
  const notes = (await readProjectNotes(repo)).sort((a, b) => a.name.localeCompare(b.name));
  const lines = [`# ${repo}`, ""];
  if (notes.length === 0) {
    lines.push("_No notes yet._");
  } else {
    for (const note of notes) lines.push(indexLine(note));
  }
  await writeFile(knowledgeProjectIndexPath(repo), `${lines.join("\n")}\n`);
}

/** Create an empty per-repo index if none exists (called when a repo is mounted). */
export async function ensureProjectIndex(repo: string): Promise<void> {
  await ensureKnowledgeStore();
  if (!existsSync(knowledgeProjectIndexPath(repo))) {
    await rebuildProjectIndex(repo);
    await rebuildMasterIndex();
  }
}

export interface TagCount {
  tag: string;
  count: number;
}

export async function topicTagCounts(): Promise<TagCount[]> {
  const notes = await readTopicNotes();
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Rebuild the thin master INDEX.md: a Projects section linking each per-repo index
 * (with note counts) and a Topics section that is a tag directory (vocabulary +
 * counts), not a per-note list.
 */
export async function rebuildMasterIndex(): Promise<void> {
  await mkdir(knowledgeRoot(), { recursive: true });
  const repos = await listProjectRepos();
  const lines = ["# Servant Knowledge", ""];

  lines.push("## Projects        (per-dir indexes; @-referenced when the repo is mounted)");
  if (repos.length === 0) {
    lines.push("_No projects yet._");
  } else {
    for (const repo of repos) {
      const count = (await readProjectNotes(repo)).length;
      lines.push(`- [${repo}](projects/${repo}/INDEX.md) — ${count} notes`);
    }
  }
  lines.push("");

  lines.push("## Topics          (flat files in topics/, find by tag via `servant recall`)");
  const tags = await topicTagCounts();
  if (tags.length === 0) {
    lines.push("_No topics yet._");
  } else {
    lines.push(`tags: ${tags.map((t) => `${t.tag}(${t.count})`).join(" ")}`);
  }

  await writeFile(knowledgeIndexPath(), `${lines.join("\n")}\n`);
}

/** Rebuild every per-repo index and the master from the notes on disk. */
export async function reconcileAllIndexes(): Promise<void> {
  await ensureKnowledgeStore();
  for (const repo of await listProjectRepos()) await rebuildProjectIndex(repo);
  await rebuildMasterIndex();
}

// --- Listing / display ---

export interface StoredNote {
  note: KnowledgeNote;
  path: string;
}

/** Every note in the store (projects then topics), each with its file path. */
export async function listAllNotes(): Promise<StoredNote[]> {
  const out: StoredNote[] = [];
  for (const repo of await listProjectRepos()) {
    for (const note of await readProjectNotes(repo)) {
      out.push({ note, path: noteFilePath(note.scope, note.name) });
    }
  }
  for (const note of await readTopicNotes()) {
    out.push({ note, path: noteFilePath(note.scope, note.name) });
  }
  return out;
}

/**
 * Render the knowledge section inlined into a workspace's own CLAUDE.md. We inline it
 * rather than `@`-importing `~/.ai_servant/knowledge/*` because those files live outside
 * the workspace cwd, and Claude Code gates such external imports behind a per-project
 * trust prompt that would fire on every fresh `servant spawn`. Inlining the lightweight
 * index keeps project knowledge eagerly in context (note bodies load on demand via
 * `servant recall`) with zero external imports.
 */
export async function renderWorkspaceKnowledgeSection(repos: readonly string[]): Promise<string> {
  const lines = [
    "<!-- servant:knowledge — auto-generated by `servant`; edits below are overwritten -->",
    "# Servant knowledge",
    "",
    "Durable knowledge prior servants captured about these repos and related topics lives in " +
      "`~/.ai_servant/knowledge/` (git-tracked). Search it with `servant recall <query>` to pull " +
      "full note bodies. Notes that name a specific file, function, or flag may have rotted — " +
      "re-verify before relying on them.",
  ];

  const tags = await topicTagCounts();
  if (tags.length > 0) {
    lines.push("", "## Topics (recall by tag)");
    lines.push(`tags: ${tags.map((t) => `${t.tag}(${t.count})`).join(" ")}`);
  }

  for (const repo of repos) {
    const notes = (await readProjectNotes(repo)).sort((a, b) => a.name.localeCompare(b.name));
    lines.push("", `## ${repo} (project knowledge)`);
    if (notes.length === 0) {
      lines.push("_No notes captured yet._");
    } else {
      for (const note of notes) lines.push(`- **${note.name}** — ${note.description}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Human label for a note's scope: "project/<repo>" or "topic [tag, …]". */
export function noteScopeLabel(note: KnowledgeNote): string {
  const repo = projectOfScope(note.scope);
  return repo ? `project/${repo}` : `topic [${note.tags.join(", ")}]`;
}

/** Full single-note rendering for recall output and the memories preview pane. */
export function renderNote(note: KnowledgeNote, path?: string): string {
  const lines = [
    `# ${note.name}  (${noteScopeLabel(note)})`,
    note.description,
    "",
    note.body.trim(),
  ];
  const meta: string[] = [];
  if (note.source.date) meta.push(note.source.date);
  if (note.source.commit) meta.push(note.source.commit);
  if (note.confidence) meta.push(`confidence: ${note.confidence}`);
  if (meta.length > 0) lines.push("", `_${meta.join(" · ")}_`);
  if (path) lines.push("", path);
  return lines.join("\n");
}

// --- Search (recall) ---

export interface SearchHit {
  note: KnowledgeNote;
  path: string;
  score: number;
}

function scoreNote(note: KnowledgeNote, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystacks = {
    name: note.name.toLowerCase(),
    tags: note.tags.join(" ").toLowerCase(),
    description: note.description.toLowerCase(),
    body: note.body.toLowerCase(),
  };
  let score = 0;
  for (const term of terms) {
    if (haystacks.tags.split(/\s+/).includes(term)) score += 5;
    else if (haystacks.tags.includes(term)) score += 3;
    if (haystacks.name.includes(term)) score += 4;
    if (haystacks.description.includes(term)) score += 2;
    if (haystacks.body.includes(term)) score += 1;
  }
  return score;
}

/** Tag + content search over all notes, ranked. Highest score first. */
export async function searchNotes(query: string): Promise<SearchHit[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const hits: SearchHit[] = [];
  for (const { note, path } of await listAllNotes()) {
    const score = scoreNote(note, terms);
    if (score > 0) hits.push({ note, path, score });
  }
  hits.sort((a, b) => b.score - a.score || a.note.name.localeCompare(b.note.name));
  return hits;
}
