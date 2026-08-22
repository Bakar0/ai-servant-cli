// The skill store (ADR-0001). Installed skills live under the servant root, namespaced by source,
// and *enabling* one copies its directory into Claude's personal skills directory as
// `servant-<name>/`. It never symlinks: the recorded content hash has to stay true, and a symlink
// hands ownership of the bytes Claude loads to whatever the link points at.
//
// Nothing here knows any skill by name, and there is no curated source list — a source is only ever
// an argument to `install`. That is the whole point of the surface: skills are data servant manages,
// not behavior it knows.

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { TEMPLATES } from "../templates/index.generated.ts";
import { contentStamp } from "./content-stamp.ts";
import {
  LEGACY_ENABLED_SKILL_PREFIX,
  enabledSkillDir,
  servantSkillsDir,
  skillStoreDir,
  skillsCheckCachePath,
  skillsManifestPath,
  skillsStoreRoot,
  userClaudeSkillsDir,
} from "./paths.ts";

/** The file that makes a directory a skill. */
export const SKILL_FILE = "SKILL.md";

/** How deep below a source's root we look for skill directories. */
const DISCOVERY_MAX_DEPTH = 3;

/**
 * One installed skill, as recorded in `skills.json`.
 *
 * `ref` is the source commit this content was last *verified* against — written at install time and
 * advanced by `check` when upstream moved without the skill's own bytes changing. It exists so the
 * cheap `git ls-remote` question ("did the source move?") can be asked before the expensive one
 * ("did this skill change?").
 */
export type SkillEntry = {
  source: string;
  ref: string;
  /** The skill directory's path within the source repo (`"."` when the repo *is* one skill). */
  path: string;
  hash: string;
  enabled: boolean;
};

export type SkillManifest = {
  version: number;
  skills: SkillEntry[];
};

export const SKILL_MANIFEST_VERSION = 1;

/**
 * How the store directory compares to the hash recorded for it.
 *
 * `modified` is what makes local adaptation honest: a skill the agent rewrote after installing it no
 * longer matches its recorded hash, and the recorded hash still describes what upstream shipped. The
 * two questions — "did we diverge?" and "did upstream move?" — stay separately answerable.
 */
export type SkillDrift = "clean" | "modified" | "missing";

/** An entry joined with everything derivable from it — what every read surface actually wants. */
export type InstalledSkill = SkillEntry & {
  name: string;
  sourceSlug: string;
  storeDir: string;
  /**
   * True when another source has a skill of the same name installed. Only one of them may be
   * enabled at a time, because they would materialize into the same `servant-<name>/`.
   */
  contested: boolean;
  drift: SkillDrift;
  /** The store directory's hash right now — differs from `hash` exactly when drift is `modified`. */
  localHash: string | null;
};

/** A source's identity: what the user typed, the store namespace, and the URL git is given. */
export type SkillSource = {
  raw: string;
  slug: string;
  gitUrl: string;
};

/**
 * Git operations the store needs, as one injectable port. Every call is read-only against the
 * source: servant clones into a temp dir and copies out, and never writes to a source repo.
 */
export type SkillGitOps = {
  /** Head commit of the source's default branch, or null when the source is unreachable. */
  lsRemoteHead(gitUrl: string): Promise<string | null>;
  /** Shallow-clone the whole source into `dest` (skills repos are small Markdown trees). */
  shallowClone(gitUrl: string, dest: string): Promise<void>;
  /**
   * Fetch only `path` from the source's head into `dest`, for re-hashing one skill without pulling
   * the whole source. Returns the commit it landed on — the sha the resulting hash describes.
   */
  sparseFetch(gitUrl: string, path: string, dest: string): Promise<string>;
  headOf(repoDir: string): Promise<string>;
};

async function git(
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = cwd
    ? await $`git -C ${cwd} ${args}`.nothrow().quiet()
    : await $`git ${args}`.nothrow().quiet();
  return {
    ok: proc.exitCode === 0,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

export const defaultGitOps: SkillGitOps = {
  async lsRemoteHead(gitUrl) {
    const res = await git(["ls-remote", gitUrl, "HEAD"]);
    if (!res.ok) return null;
    const sha = res.out.trim().split(/\s+/)[0];
    return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  },
  async shallowClone(gitUrl, dest) {
    const res = await git(["clone", "--depth", "1", gitUrl, dest]);
    if (!res.ok) {
      throw new Error(`git clone of ${gitUrl} failed: ${res.err.trim() || "(no output)"}`);
    }
  },
  async sparseFetch(gitUrl, path, dest) {
    await mkdir(dest, { recursive: true });
    // Fetch `HEAD` rather than the sha `ls-remote` just reported: a server only serves an arbitrary
    // sha with `uploadpack.allowAnySHA1InWant` set, and the sha we actually landed on is reported
    // back, so nothing is assumed about the two agreeing.
    const steps: string[][] = [
      ["init", "-q"],
      ["remote", "add", "origin", gitUrl],
      ["sparse-checkout", "set", "--no-cone", path === "." ? "/*" : `/${path}`],
      ["fetch", "-q", "--depth", "1", "origin", "HEAD"],
      ["checkout", "-q", "FETCH_HEAD"],
    ];
    for (const step of steps) {
      const res = await git(step, dest);
      if (!res.ok) {
        throw new Error(
          `git ${step[0]} while fetching ${path} from ${gitUrl} failed: ${res.err.trim() || "(no output)"}`,
        );
      }
    }
    return this.headOf(dest);
  },
  async headOf(repoDir) {
    const res = await git(["rev-parse", "HEAD"], repoDir);
    if (!res.ok) throw new Error(`git rev-parse in ${repoDir} failed: ${res.err.trim()}`);
    return res.out.trim();
  },
};

/**
 * Normalize whatever the user typed into a source identity.
 *
 * `owner/repo` is read as GitHub, because that is what a bare slug means everywhere else in this
 * CLI. Anything with a scheme, or a filesystem path, is handed to git as-is.
 */
export function parseSource(raw: string): SkillSource {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) throw new Error("servant skills: a source is required.");

  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed) && !trimmed.startsWith(".")) {
    return {
      raw: trimmed,
      slug: trimmed.replace("/", "__"),
      gitUrl: `https://github.com/${trimmed}.git`,
    };
  }

  // A URL or a filesystem path: its last two path segments name it.
  const segments = trimmed
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean);
  const slug = segments
    .slice(-2)
    .join("__")
    .replace(/[^\w.-]/g, "-");
  return { raw: trimmed, slug: slug || "source", gitUrl: trimmed };
}

/** A skill's name: its directory name in the source, or the source's own when the repo is a skill. */
export function skillName(entry: Pick<SkillEntry, "source" | "path">): string {
  if (entry.path !== "." && entry.path.length > 0) return basename(entry.path);
  const parts = parseSource(entry.source).slug.split("__");
  return parts[parts.length - 1] ?? entry.source;
}

/**
 * The content hash of a skill directory: sha256 over every file's relative path and bytes in
 * sorted-path order, truncated to 12 hex. Path-sensitive, so a rename is a change; order-stable, so
 * the same tree hashes the same on any machine. Fields are NUL-separated because that is the one
 * byte that cannot appear in either a path or a Markdown file.
 */
export async function hashSkillDir(dir: string): Promise<string> {
  const files = await walkFiles(dir);
  return hashFiles(
    await Promise.all(
      files.map(async (rel) => ({ rel, content: await Bun.file(join(dir, rel)).text() })),
    ),
  );
}

/** The same hash over files held in memory — what a core skill has instead of a directory. */
function hashFiles(files: readonly SkillFile[]): string {
  const parts: string[] = [];
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    parts.push(f.rel, "\0", f.content, "\0");
  }
  return contentStamp(parts.join(""));
}

/** One file of a skill: its path relative to the skill directory, and its bytes. */
type SkillFile = { rel: string; content: string };

async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Core skills — the ones that ship inside the binary rather than arriving from a source.
//
// They are listed and scored like any other skill (CONTEXT.md, *Core skill*) but they are never
// disableable and never removable: there is nothing to remove, because their only copy on disk is
// the materialized one and servant rewrites it from the binary. Their names are reserved, so an
// installed skill can never materialize over one — both would land in the same directory.
// ---------------------------------------------------------------------------------------------

/** The source recorded for a skill that ships with servant. Not a git source; nothing fetches it. */
export const CORE_SOURCE = "core";

/** Where core skills live in the embedded template manifest. */
const CORE_SKILL_TEMPLATE_PREFIX = "servant_root/.claude/skills/";

/**
 * The `servant-` prefix every core skill's directory carries.
 *
 * Claude Code invokes a skill by its directory name, so this is the invocation: `/servant-recall`.
 * It is identity, not safety — ADR-0002 dropped the prefix from *installed* copies because
 * containment replaced it as a guard. Here it groups servant's own set, keeps generic words like
 * `goal` and `skills` from being claimed, and makes the Claude and Codex invocations the same
 * string (Codex prompts are flat files named `servant-<id>.md`).
 */
export const CORE_SKILL_PREFIX = "servant-";

/** Every core skill's shipped files, keyed by the skill's directory name. */
function coreSkillFiles(): Map<string, SkillFile[]> {
  const out = new Map<string, SkillFile[]>();
  for (const t of TEMPLATES) {
    if (!t.rel.startsWith(CORE_SKILL_TEMPLATE_PREFIX)) continue;
    const rest = t.rel.slice(CORE_SKILL_TEMPLATE_PREFIX.length);
    const slash = rest.indexOf("/");
    // A loose file directly under skills/ belongs to no skill.
    if (slash <= 0) continue;
    const name = rest.slice(0, slash);
    const files = out.get(name) ?? [];
    files.push({ rel: rest.slice(slash + 1), content: t.content });
    out.set(name, files);
  }
  return out;
}

/** The name of every core skill, sorted. Cheap — this is what the reserved-name guard reads. */
export function coreSkillNames(): string[] {
  return [...coreSkillFiles().keys()].sort();
}

/** True when `name` belongs to a core skill, and so may not be taken by an installed one. */
export function isCoreSkillName(name: string): boolean {
  return coreSkillFiles().has(name);
}

/**
 * Write every core skill into the servant skills directory, and the only writer that does.
 *
 * Called from `ensureServantAssets` (so a spawn refreshes them) and from the `servant skills`
 * commands (so a listing never reports a skill that is not there). Rewrites a file only when its
 * bytes moved, which is also what makes a hand-edit of a core skill temporary rather than silent.
 *
 * It does not delete. A core skill that is *retired* would linger and keep loading — handle that
 * with an explicit retired-name list when it first happens, the way retired slash commands are.
 */
export async function ensureCoreSkills(): Promise<string[]> {
  const written: string[] = [];
  for (const [name, files] of coreSkillFiles()) {
    const dir = enabledSkillDir(name);
    let touched = false;
    for (const f of files) {
      const dest = join(dir, f.rel);
      const existing = await readTextOr(dest, null);
      if (existing === f.content) continue;
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, f.content);
      touched = true;
    }
    if (touched) written.push(name);
  }
  return written.sort();
}

async function readTextOr(path: string, fallback: string | null): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback;
  return file.text();
}

/**
 * The core skills as listing rows. Derived entirely from the binary and the directory they are
 * written to — nothing about them is recorded in `skills.json`, which stays a record of what was
 * *installed*.
 *
 * `storeDir` is the materialized directory because that is the only copy on disk; a core skill's
 * store is the binary. `drift` therefore answers a real question: has this copy been hand-edited
 * since servant last wrote it (until the next write puts it back).
 */
export async function coreSkills(): Promise<InstalledSkill[]> {
  const rows = await Promise.all(
    [...coreSkillFiles()].map(async ([name, files]) => {
      const dir = enabledSkillDir(name);
      const hash = hashFiles(files);
      const localHash = existsSync(dir) ? await hashSkillDir(dir) : null;
      return {
        source: CORE_SOURCE,
        ref: "",
        path: `${CORE_SKILL_TEMPLATE_PREFIX}${name}`,
        hash,
        enabled: true,
        name,
        sourceSlug: CORE_SOURCE,
        storeDir: dir,
        contested: false,
        drift: (localHash === null
          ? "missing"
          : localHash === hash
            ? "clean"
            : "modified") as SkillDrift,
        localHash,
      };
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Refuse to let an installed skill take a core skill's name.
 *
 * Both would materialize into the same directory, and `materialize` deletes the destination before
 * copying — so a same-named install does not shadow a core skill, it destroys it, and the next
 * asset sync leaves a hybrid of the two. Refusing at install and again at enable means the
 * collision is a message rather than a repair.
 */
function assertCoreNameFree(name: string, what: string): void {
  if (!isCoreSkillName(name)) return;
  throw new Error(
    `servant skills: "${name}" is the name of a core skill that ships with servant. ${what} would overwrite it — rename it upstream or leave it uninstalled.`,
  );
}

/** Refuse an operation that would treat a core skill as installed. */
function assertNotCore(skill: InstalledSkill, verb: string): void {
  if (skill.source !== CORE_SOURCE) return;
  throw new Error(
    `servant skills: ${skill.name} ships with servant and is always on — it cannot be ${verb}.`,
  );
}

export async function readManifest(): Promise<SkillManifest> {
  const file = Bun.file(skillsManifestPath());
  if (!(await file.exists())) return { version: SKILL_MANIFEST_VERSION, skills: [] };
  try {
    return coerceManifest(await file.json());
  } catch {
    return { version: SKILL_MANIFEST_VERSION, skills: [] };
  }
}

function coerceManifest(raw: unknown): SkillManifest {
  const out: SkillManifest = { version: SKILL_MANIFEST_VERSION, skills: [] };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.skills)) return out;
  for (const item of obj.skills) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.source !== "string" || typeof e.path !== "string") continue;
    out.skills.push({
      source: e.source,
      ref: typeof e.ref === "string" ? e.ref : "",
      path: e.path,
      hash: typeof e.hash === "string" ? e.hash : "",
      enabled: e.enabled === true,
    });
  }
  return out;
}

export async function writeManifest(manifest: SkillManifest): Promise<void> {
  await mkdir(skillsStoreRoot(), { recursive: true });
  const skills = [...manifest.skills].sort((a, b) => {
    const byName = skillName(a).localeCompare(skillName(b));
    return byName !== 0 ? byName : a.source.localeCompare(b.source);
  });
  await Bun.write(
    skillsManifestPath(),
    `${JSON.stringify({ version: SKILL_MANIFEST_VERSION, skills }, null, 2)}\n`,
  );
}

/**
 * Every skill servant knows about: the core set first, then everything installed from a source.
 *
 * This is what a read surface wants — `servant skills list`, the picker, `resolveSkill`. Anything
 * that acts on a *source* (update checks, re-materializing an enabled copy) wants
 * {@link listInstalledSkills} instead: a core skill has no source to ask and no copy to restore.
 */
export async function listSkills(): Promise<InstalledSkill[]> {
  return [...(await coreSkills()), ...(await listInstalledSkills())];
}

/**
 * Every installed skill, joined with its derived fields.
 *
 * Each store directory is re-hashed on the way out, so a local edit is never invisible: the recorded
 * hash is what upstream shipped, and drift is the difference. Skills are small Markdown trees, so
 * paying for the read on every listing is what buys the guarantee.
 */
export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  const { skills } = await readManifest();
  const counts = new Map<string, number>();
  for (const e of skills) {
    const n = skillName(e);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return Promise.all(
    skills.map(async (e) => {
      const name = skillName(e);
      const sourceSlug = parseSource(e.source).slug;
      const storeDir = skillStoreDir(sourceSlug, name);
      const localHash = existsSync(storeDir) ? await hashSkillDir(storeDir) : null;
      const drift: SkillDrift =
        localHash === null ? "missing" : localHash === e.hash ? "clean" : "modified";
      return {
        ...e,
        name,
        sourceSlug,
        storeDir,
        contested: (counts.get(name) ?? 0) > 1,
        drift,
        localHash,
      };
    }),
  );
}

/**
 * Resolve a selector to one installed skill. A bare name is enough until two sources ship it, at
 * which point the caller has to say which one — silently picking would enable the wrong bytes.
 */
export async function resolveSkill(selector: string): Promise<InstalledSkill> {
  const all = await listSkills();
  const qualified = all.filter(
    (s) => `${s.source}/${s.name}` === selector || `${s.sourceSlug}/${s.name}` === selector,
  );
  if (qualified.length === 1) return qualified[0] as InstalledSkill;

  const byName = all.filter((s) => s.name === selector);
  if (byName.length === 1) return byName[0] as InstalledSkill;
  if (byName.length === 0) {
    throw new Error(`servant skills: "${selector}" is not installed. Run \`servant skills list\`.`);
  }
  const options = byName.map((s) => `  ${s.source}/${s.name}`).join("\n");
  throw new Error(
    `servant skills: "${selector}" is installed from more than one source — name one:\n${options}`,
  );
}

/** Relative paths of every skill directory in a checkout, `"."` when the repo itself is a skill. */
export async function discoverSkills(repoDir: string): Promise<string[]> {
  if (existsSync(join(repoDir, SKILL_FILE))) return ["."];
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > DISCOVERY_MAX_DEPTH) return;
    for (const e of await readdir(join(repoDir, rel), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (existsSync(join(repoDir, child, SKILL_FILE))) found.push(child);
      else await walk(child, depth + 1);
    }
  };
  await walk("", 1);
  return found.sort();
}

/** One skill a source offers, as read without installing it. */
export type CatalogEntry = {
  name: string;
  path: string;
  /** The `description:` from the skill's own frontmatter — what it says it is for. */
  description: string;
  /** Names this skill's prose mentions as `/other-skill`, so a consumer can ask about them. */
  mentions: string[];
};

export type SourceCatalog = {
  source: SkillSource;
  ref: string;
  skills: CatalogEntry[];
};

/**
 * Read what a source offers without installing any of it: every skill's name, path, stated purpose,
 * and the other skills its prose points at.
 *
 * This is a read, not a decision. Which of them to install — and what to do about a skill that leans
 * on three others — is a conversation had above this layer, which is why nothing here filters,
 * ranks, or follows a mention.
 */
export async function catalogSource(
  rawSource: string,
  opts: { git?: SkillGitOps } = {},
): Promise<SourceCatalog> {
  const gitOps = opts.git ?? defaultGitOps;
  const source = parseSource(rawSource);
  const tmp = await mkdtemp(join(tmpdir(), "servant-skills-catalog-"));
  const checkout = join(tmp, "src");
  try {
    await gitOps.shallowClone(source.gitUrl, checkout);
    const ref = await gitOps.headOf(checkout);
    const paths = await discoverSkills(checkout);
    if (paths.length === 0) {
      throw new Error(
        `servant skills: no ${SKILL_FILE} found in ${source.raw} — it does not look like a skills source.`,
      );
    }
    const skills = await Promise.all(
      paths.map(async (path) => {
        const dir = path === "." ? checkout : join(checkout, path);
        const doc = await readFile(join(dir, SKILL_FILE), "utf8");
        return {
          name: skillName({ source: source.raw, path }),
          path,
          description: readFrontmatterDescription(doc),
          mentions: readSkillMentions(doc, paths, source.raw),
        };
      }),
    );
    return { source, ref, skills };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** A skill's stated purpose, from its YAML frontmatter. */
function readFrontmatterDescription(doc: string): string {
  const match = doc.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return "";
  try {
    const parsed: unknown = Bun.YAML.parse(match[1]);
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>).description;
      if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    }
  } catch {
    // Malformed frontmatter is the source's problem, not a reason to fail the catalog.
  }
  return "";
}

/**
 * Sibling skills this one's prose points at, as `/name`.
 *
 * Only names the same source actually offers are reported — a `/handoff` that resolves to nothing
 * here is a dangling reference the consumer would have to guess about, and guessing is what this
 * layer must not do. Whether a mention means "also install that" is never decided here.
 */
function readSkillMentions(doc: string, paths: string[], source: string): string[] {
  const siblings = new Set(paths.map((p) => skillName({ source, path: p })));
  const self = doc.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0] ?? "";
  const found = new Set<string>();
  for (const [, name] of doc.matchAll(/(?:^|[\s(`])\/([a-z][\w-]*)/g)) {
    if (name && siblings.has(name) && !self.includes(`name: ${name}`)) found.add(name);
  }
  return [...found].sort();
}

export type InstallOutcome = {
  name: string;
  path: string;
  hash: string;
  /** The hash this skill previously carried, when it was already installed from this source. */
  previousHash?: string;
  /** True when the enabled copy was refreshed as part of this install. */
  refreshedEnabled: boolean;
};

export type InstallResult = {
  source: SkillSource;
  ref: string;
  installed: InstallOutcome[];
};

/**
 * Clone a source into a temp dir and hand its discovered skills to `select`, which returns the
 * paths to install. The clone is deleted before this returns — the store is the only copy that
 * outlives it.
 *
 * Installing is how an upstream change is *reached* (ADR-0001: detected, never applied silently).
 * Re-installing an already-enabled skill therefore also refreshes its enabled copy, so the bytes
 * Claude loads never lag the store.
 *
 * A store directory that has drifted from its recorded hash holds work someone did deliberately, so
 * overwriting it takes `force`. Without that, "reach the new upstream version" and "throw away our
 * adaptation" would be the same keystroke.
 */
export async function installFromSource(
  rawSource: string,
  select: (candidates: string[]) => Promise<string[] | null>,
  opts: { git?: SkillGitOps; force?: boolean } = {},
): Promise<InstallResult | null> {
  const gitOps = opts.git ?? defaultGitOps;
  const source = parseSource(rawSource);
  const tmp = await mkdtemp(join(tmpdir(), "servant-skills-"));
  const checkout = join(tmp, "src");
  try {
    await gitOps.shallowClone(source.gitUrl, checkout);
    const ref = await gitOps.headOf(checkout);
    const candidates = await discoverSkills(checkout);
    if (candidates.length === 0) {
      throw new Error(
        `servant skills: no ${SKILL_FILE} found in ${source.raw} — it does not look like a skills source.`,
      );
    }
    const chosen = await select(candidates);
    if (!chosen || chosen.length === 0) return null;

    const unknown = chosen.filter((p) => !candidates.includes(p));
    if (unknown.length > 0) {
      const available = candidates.map((c) => skillName({ source: source.raw, path: c }));
      throw new Error(
        `servant skills: ${source.raw} has no skill ${unknown.join(", ")}.\n  Available: ${available.join(", ")}`,
      );
    }

    // Refuse the whole install rather than part of it: a reserved name is a fact about the source
    // and the binary, knowable before anything is written.
    for (const path of chosen) {
      assertCoreNameFree(skillName({ source: source.raw, path }), "Installing it");
    }

    const manifest = await readManifest();
    const installed: InstallOutcome[] = [];
    for (const path of chosen) {
      const name = skillName({ source: source.raw, path });
      const dest = skillStoreDir(source.slug, name);
      const prior = manifest.skills.find((e) => e.source === source.raw && skillName(e) === name);
      if (prior && !opts.force && existsSync(dest) && (await hashSkillDir(dest)) !== prior.hash) {
        throw new Error(
          `servant skills: ${name} has local changes (${dest}).\n` +
            "  Installing would overwrite them. Pass --force to discard them and take upstream's version.",
        );
      }
      await rm(dest, { recursive: true, force: true });
      await mkdir(dirname(dest), { recursive: true });
      await cp(path === "." ? checkout : join(checkout, path), dest, {
        recursive: true,
        filter: (src) => basename(src) !== ".git",
      });
      const hash = await hashSkillDir(dest);
      const enabled = prior?.enabled ?? false;
      manifest.skills = manifest.skills.filter((e) => e !== prior);
      manifest.skills.push({ source: source.raw, ref, path, hash, enabled });
      if (enabled) await materialize(dest, name);
      installed.push({
        name,
        path,
        hash,
        ...(prior ? { previousHash: prior.hash } : {}),
        refreshedEnabled: enabled,
      });
    }
    await writeManifest(manifest);
    await forgetCheckResults(installed.map((i) => `${source.raw}/${i.name}`));
    return { source, ref, installed };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Copy a store directory into the servant skills directory. The only writer of an enabled copy. */
async function materialize(storeDir: string, name: string): Promise<void> {
  const dest = enabledSkillDir(name);
  await removeEnabledCopy(dest);
  await mkdir(servantSkillsDir(), { recursive: true });
  await cp(storeDir, dest, { recursive: true });
}

/**
 * Delete an enabled copy, refusing anything that is not a direct child of the servant skills
 * directory.
 *
 * Containment is the guard (ADR-0002): servant owns that directory outright, so there is nothing
 * of the user's inside it to reach. A traversing or absolute `name` cannot escape it, which is
 * strictly stronger than the name prefix this replaced.
 */
async function removeEnabledCopy(dir: string): Promise<void> {
  const root = servantSkillsDir();
  if (resolve(dir) !== join(root, basename(dir)) || basename(dir).length === 0) {
    throw new Error(
      `servant skills: refusing to remove ${dir} — only directories directly under ${root} are servant's.`,
    );
  }
  await rm(dir, { recursive: true, force: true });
}

/**
 * Make the enabled set true again: sweep the copies the pre-ADR-0002 layout left in the user's
 * personal skills directory, and re-materialize any skill recorded as enabled that has no copy where
 * one now belongs.
 *
 * Both halves are needed, and the second is what makes the first safe. `enabled: true` is a claim
 * that Claude can see the skill; sweeping the old copy without writing the new one would leave that
 * claim false, and the listing would happily report `on` for a skill loaded from nowhere.
 */
export async function reconcileEnabledCopies(): Promise<{
  removedLegacy: string[];
  restored: string[];
}> {
  const legacyDir = userClaudeSkillsDir();
  const removedLegacy: string[] = [];
  if (existsSync(legacyDir)) {
    for (const e of await readdir(legacyDir, { withFileTypes: true })) {
      // Only ever the prefix servant itself wrote — everything else in there is the user's.
      if (!e.isDirectory() || !e.name.startsWith(LEGACY_ENABLED_SKILL_PREFIX)) continue;
      await rm(join(legacyDir, e.name), { recursive: true, force: true });
      removedLegacy.push(e.name);
    }
  }

  const restored: string[] = [];
  for (const skill of await listInstalledSkills()) {
    if (!skill.enabled || existsSync(enabledSkillDir(skill.name))) continue;
    if (!existsSync(skill.storeDir)) continue;
    await materialize(skill.storeDir, skill.name);
    restored.push(skill.name);
  }
  return { removedLegacy: removedLegacy.sort(), restored: restored.sort() };
}

export type EnableResult = {
  skill: InstalledSkill;
  /** The same-named skill from another source that had to be disabled to make room. */
  swappedOut?: InstalledSkill;
};

export async function enableSkill(selector: string): Promise<EnableResult> {
  const target = await resolveSkill(selector);
  assertNotCore(target, "enabled");
  assertCoreNameFree(target.name, "Enabling it");
  if (!existsSync(target.storeDir)) {
    throw new Error(
      `servant skills: ${target.name} is recorded but missing from the store (${target.storeDir}). Reinstall it.`,
    );
  }

  const manifest = await readManifest();
  // One name, one enabled skill: two sources' versions would materialize into the same directory.
  const rival = manifest.skills.find(
    (e) => e.enabled && skillName(e) === target.name && e.source !== target.source,
  );
  const swappedOut = rival
    ? (await listInstalledSkills()).find((s) => s.source === rival.source && s.name === target.name)
    : undefined;
  if (rival) rival.enabled = false;

  for (const e of manifest.skills) {
    if (e.source === target.source && skillName(e) === target.name) e.enabled = true;
  }
  await materialize(target.storeDir, target.name);
  await writeManifest(manifest);
  return { skill: { ...target, enabled: true }, ...(swappedOut ? { swappedOut } : {}) };
}

export async function disableSkill(selector: string): Promise<InstalledSkill> {
  const target = await resolveSkill(selector);
  assertNotCore(target, "disabled");
  const manifest = await readManifest();
  for (const e of manifest.skills) {
    if (e.source === target.source && skillName(e) === target.name) e.enabled = false;
  }
  await removeEnabledCopy(enabledSkillDir(target.name));
  await writeManifest(manifest);
  return { ...target, enabled: false };
}

export type CheckStatus = "current" | "outdated" | "unreachable";

export type CheckResult = {
  name: string;
  source: string;
  /** How the *upstream* skill compares to what was installed. Independent of local drift. */
  status: CheckStatus;
  /** How the local store directory compares to the hash recorded for it. */
  drift: SkillDrift;
  /** The source's head at check time (absent when unreachable). */
  head?: string;
  /** Upstream's hash for this skill, when it differs from the installed one. */
  upstreamHash?: string;
};

/** What the last `check` observed, keyed by `<source>/<name>`. Derived, so it lives in the cache. */
export type CheckCache = Record<
  string,
  { ts: number; status: CheckStatus; drift: SkillDrift; upstreamHash?: string }
>;

export async function readCheckResults(): Promise<CheckCache> {
  const file = Bun.file(skillsCheckCachePath());
  if (!(await file.exists())) return {};
  try {
    const raw: unknown = await file.json();
    return raw && typeof raw === "object" ? (raw as CheckCache) : {};
  } catch {
    return {};
  }
}

async function writeCheckResults(cache: CheckCache): Promise<void> {
  const path = skillsCheckCachePath();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
}

/** Drop stale observations for skills that were just re-installed. */
async function forgetCheckResults(keys: string[]): Promise<void> {
  const cache = await readCheckResults();
  const present = keys.filter((k) => k in cache);
  if (present.length === 0) return;
  for (const key of present) delete cache[key];
  await writeCheckResults(cache);
}

/**
 * Ask every installed skill's source whether it moved, and only then whether the skill itself
 * changed: one `ls-remote` per source, and a sparse fetch of exactly the skills whose source did
 * move. Never re-pulls a whole source, and never applies what it finds.
 *
 * A source that moved without changing a skill's bytes advances that entry's `ref`, so the same
 * unchanged skill is not re-fetched on every check.
 */
export async function checkForUpdates(opts: { git?: SkillGitOps } = {}): Promise<CheckResult[]> {
  const gitOps = opts.git ?? defaultGitOps;
  const skills = await listInstalledSkills();
  const heads = new Map<string, string | null>();
  for (const source of new Set(skills.map((s) => s.source))) {
    heads.set(source, await gitOps.lsRemoteHead(parseSource(source).gitUrl));
  }

  const manifest = await readManifest();
  const results: CheckResult[] = [];

  for (const skill of skills) {
    const base = { name: skill.name, source: skill.source, drift: skill.drift };
    const head = heads.get(skill.source) ?? null;
    if (head === null) {
      results.push({ ...base, status: "unreachable" });
      continue;
    }
    if (head === skill.ref) {
      results.push({ ...base, status: "current", head });
      continue;
    }

    const upstream = await hashUpstream(gitOps, skill);
    if (upstream.hash === skill.hash) {
      // Upstream moved but this skill's bytes did not: advance the verified ref so the next check
      // stops at the cheap `ls-remote` question instead of re-fetching an unchanged skill.
      const entry = manifest.skills.find(
        (e) => e.source === skill.source && skillName(e) === skill.name,
      );
      if (entry) entry.ref = upstream.ref;
      results.push({ ...base, status: "current", head });
    } else {
      results.push({ ...base, status: "outdated", head, upstreamHash: upstream.hash });
    }
  }

  await writeManifest(manifest);

  const cache = await readCheckResults();
  const ts = Date.now();
  for (const r of results) {
    cache[`${r.source}/${r.name}`] = {
      ts,
      status: r.status,
      drift: r.drift,
      ...(r.upstreamHash ? { upstreamHash: r.upstreamHash } : {}),
    };
  }
  await writeCheckResults(cache);
  return results;
}

async function hashUpstream(
  gitOps: SkillGitOps,
  skill: InstalledSkill,
): Promise<{ hash: string; ref: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "servant-skills-check-"));
  try {
    const ref = await gitOps.sparseFetch(parseSource(skill.source).gitUrl, skill.path, tmp);
    const hash = await hashSkillDir(skill.path === "." ? tmp : join(tmp, skill.path));
    return { hash, ref };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** A skill's SKILL.md, for the picker's preview. */
export async function readSkillDoc(storeDir: string): Promise<string> {
  try {
    return await readFile(join(storeDir, SKILL_FILE), "utf8");
  } catch {
    return `(no ${SKILL_FILE} in ${storeDir})`;
  }
}
