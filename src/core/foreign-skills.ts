// Skills a servant session can invoke that the store does not own.
//
// `servant skills list` was presented as the account of what a session can invoke while reading only
// the store — and that blind spot is not hypothetical: it let seven skills load twice at two
// different versions, and thirteen never-invoked ones sit resident across 394 sessions, without any
// servant surface saying so. It took a bespoke audit to notice.
//
// Two places a skill arrives from that servant did not put it in:
//   - an enabled Claude Code plugin that ships a `skills/` tree
//   - `~/.claude/skills/`, the user's own hand-installed directory
//
// This module only ever reads. Removing a foreign skill is the user's action — ADR-0002 says nothing
// servant runs writes outside `~/.ai_servant/`, and detection is what keeps the measurement pipeline
// that found the problem intact. See the closing comment on #11 for why isolation was rejected.

import { basename, join } from "node:path";
import {
  userClaudeInstalledPluginsPath,
  userClaudeSettingsPath,
  userClaudeSkillsDir,
} from "./paths.ts";
import {
  SKILL_FILE,
  findSkillDirs,
  readFrontmatterDescription,
  readModelInvocable,
} from "./skill-doc.ts";

/**
 * How deep below a plugin's install directory a skill may be nested.
 *
 * Four, because the shape in the wild is `skills/<category>/<name>/SKILL.md` and nothing promises a
 * category layer is the last one. Cheap to raise; the walk skips dependency trees already.
 */
const PLUGIN_SKILL_MAX_DEPTH = 4;

const APPROX_CHARS_PER_TOKEN = 4;

/** Where a foreign skill comes from — enough to act on it without servant having to guess. */
export type ForeignOrigin =
  | {
      kind: "plugin";
      /** `<plugin>@<marketplace>`, the id every `claude plugin` verb takes. */
      id: string;
      plugin: string;
      marketplace: string;
      /** `user`, `project` or `managed`. A managed plugin is org policy, not the user's to disable. */
      scope: string;
      version: string;
      installPath: string;
    }
  | { kind: "personal"; dir: string };

/** One skill reachable by a session that the servant store did not install. */
export type ForeignSkill = {
  /** The bare name — what collides with a store skill, whatever the invocation looks like. */
  name: string;
  /**
   * What a session actually types. A plugin's skills are namespaced `<plugin>:<name>`, which is why
   * a colliding pair can both be resident: two distinct invocations, two near-identical
   * descriptions, and the model choosing between them.
   */
  invocation: string;
  dir: string;
  origin: ForeignOrigin;
  description: string;
  modelInvocable: boolean;
  /**
   * Resident cost: the description text Claude Code keeps in context for a skill it may offer. Zero
   * for a skill carrying `disable-model-invocation`, which the agent is never shown.
   */
  approxTokens: number;
};

/** One install record in Claude Code's `installed_plugins.json`. */
type PluginInstall = {
  id: string;
  scope: string;
  version: string;
  installPath: string;
};

/**
 * Every skill a session can reach from outside the store, grouped by where it comes from.
 *
 * Deliberately tolerant: an unreadable settings file or install record yields fewer plugins, never
 * an exception. A listing that fails because one JSON file is mid-write is worse than a listing that
 * reports what it could read.
 */
export async function listForeignSkills(): Promise<ForeignSkill[]> {
  const skills = [...(await pluginSkills()), ...(await personalSkills())];
  // Grouped by origin rather than by name: the question a reader brings here is "what is this plugin
  // putting in my sessions", and a name sort interleaves one hand-installed skill through the middle
  // of a thirty-five-skill plugin.
  return skills.sort(
    (a, b) =>
      describeOrigin(a.origin).localeCompare(describeOrigin(b.origin)) ||
      a.name.localeCompare(b.name),
  );
}

async function pluginSkills(): Promise<ForeignSkill[]> {
  const enabled = await readEnabledPlugins();
  const installs = (await readPluginInstalls()).filter((p) => enabled[p.id] !== false);
  const perPlugin = await Promise.all(
    installs.map(async (install) => {
      const plugin = install.id.split("@")[0] ?? install.id;
      const rels = await findSkillDirs(install.installPath, PLUGIN_SKILL_MAX_DEPTH);
      return Promise.all(
        rels.map(async (rel) => {
          const dir = rel === "." ? install.installPath : join(install.installPath, rel);
          const name = rel === "." ? plugin : basename(rel);
          return describe(name, `${plugin}:${name}`, dir, {
            kind: "plugin" as const,
            id: install.id,
            plugin,
            marketplace: install.id.split("@")[1] ?? "",
            scope: install.scope,
            version: install.version,
            installPath: install.installPath,
          });
        }),
      );
    }),
  );
  return perPlugin.flat();
}

async function personalSkills(): Promise<ForeignSkill[]> {
  const root = userClaudeSkillsDir();
  // One level only: `~/.claude/skills/<name>/SKILL.md` is the layout Claude Code documents, and a
  // deeper walk here would start reporting a skill's own bundled examples as skills.
  const rels = await findSkillDirs(root, 1);
  return Promise.all(
    rels
      .filter((rel) => rel !== ".")
      .map((rel) =>
        describe(basename(rel), basename(rel), join(root, rel), { kind: "personal", dir: root }),
      ),
  );
}

async function describe(
  name: string,
  invocation: string,
  dir: string,
  origin: ForeignOrigin,
): Promise<ForeignSkill> {
  const doc = await readSkillText(join(dir, SKILL_FILE));
  const description = readFrontmatterDescription(doc);
  const modelInvocable = readModelInvocable(doc);
  return {
    name,
    invocation,
    dir,
    origin,
    description,
    modelInvocable,
    approxTokens: modelInvocable
      ? Math.round((invocation.length + description.length) / APPROX_CHARS_PER_TOKEN)
      : 0,
  };
}

/**
 * Which plugins are on, from the user settings file `claude plugin enable/disable` writes to.
 *
 * A plugin absent from the map reads as enabled: that is how a managed (org-policy) plugin arrives,
 * and over-reporting a foreign skill is the honest direction for a surface whose whole job is to
 * stop one going unnoticed.
 *
 * Not read here: Claude Code's own per-skill `/skills` toggle. Its key (`skillOverrides`) is known
 * but the shape of its value is not, and inventing one would put this surface back to being
 * confidently wrong about reachability — the exact failure it exists to end.
 */
async function readEnabledPlugins(): Promise<Record<string, boolean>> {
  const raw = await readJson(userClaudeSettingsPath());
  const value = (raw as { enabledPlugins?: unknown })?.enabledPlugins;
  if (!value || typeof value !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on === "boolean") out[id] = on;
  }
  return out;
}

async function readPluginInstalls(): Promise<PluginInstall[]> {
  const raw = await readJson(userClaudeInstalledPluginsPath());
  const plugins = (raw as { plugins?: unknown })?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const out: PluginInstall[] = [];
  for (const [id, entries] of Object.entries(plugins as Record<string, unknown>)) {
    // One record per id, even when the file holds several (the same plugin recorded at more than one
    // scope). A plugin's skills are invoked as `<plugin>:<name>`, so only one of those copies is ever
    // reachable under that name — emitting both would double every count downstream while adding no
    // skill a session can actually call.
    const record = (Array.isArray(entries) ? entries : [entries]).find(
      (e): e is Record<string, unknown> =>
        !!e &&
        typeof e === "object" &&
        typeof (e as Record<string, unknown>).installPath === "string",
    );
    if (!record) continue;
    out.push({
      id,
      scope: typeof record.scope === "string" ? record.scope : "unknown",
      version: typeof record.version === "string" ? record.version : "unknown",
      installPath: String(record.installPath),
    });
  }
  return out;
}

/** A skill doc, or empty when it cannot be read — an unreadable SKILL.md is a row, not a failure. */
async function readSkillText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return await Bun.file(path).json();
  } catch {
    return null;
  }
}

/** A bare name a session can reach twice: once from the store, once from somewhere servant does not own. */
export type SkillCollision = {
  name: string;
  foreignInvocation: string;
  /** Where the foreign copy comes from, ready to print. */
  foreignOrigin: ForeignOrigin;
  /** Every store source shipping the same bare name. */
  storeSources: string[];
  /**
   * True when the agent is actually shown the foreign twin, so the two compete for an invocation and
   * the model decides. A collision with a `disable-model-invocation` skill is real but inert: it only
   * shares a name a human might type.
   *
   * Deliberately not called `contested` — `InstalledSkill.contested` already means "two *store*
   * sources ship this name", and one word for two things here is how a reader draws the wrong
   * conclusion from a count.
   */
  competing: boolean;
};

/**
 * Pair each foreign skill with the *loaded* store skills sharing its bare name.
 *
 * Bare name, not invocation: `kit:code-review` and `code-review` are different strings to type and
 * the same skill to choose between. That is the failure mode measured in #12 — the namespaced twin
 * took 81 invocations to the store copy's 5, so the collision decided which bytes ran, silently.
 *
 * Only enabled store skills count. A disabled one is not in the session at all, so there is nothing
 * for the foreign copy to be confused with — reporting it would be inventing a collision that has
 * not happened yet.
 */
export function findCollisions(
  store: readonly { name: string; source: string; enabled: boolean }[],
  foreign: readonly ForeignSkill[],
): SkillCollision[] {
  const sourcesByName = new Map<string, string[]>();
  for (const s of store) {
    if (!s.enabled) continue;
    sourcesByName.set(s.name, [...(sourcesByName.get(s.name) ?? []), s.source]);
  }
  const out: SkillCollision[] = [];
  for (const f of foreign) {
    const storeSources = sourcesByName.get(f.name);
    if (!storeSources) continue;
    out.push({
      name: f.name,
      foreignInvocation: f.invocation,
      foreignOrigin: f.origin,
      storeSources: [...storeSources].sort(),
      competing: f.modelInvocable,
    });
  }
  return out;
}

/**
 * Where a foreign skill comes from, as one line a person can act on.
 *
 * A scope other than `user` is named, because it changes who may act: a `managed` plugin is org
 * policy, and telling someone to remove one they cannot remove is worse than saying nothing.
 */
export function describeOrigin(origin: ForeignOrigin): string {
  if (origin.kind === "personal") return origin.dir;
  return `plugin ${origin.id}${origin.scope === "user" ? "" : ` (${origin.scope})`}`;
}
