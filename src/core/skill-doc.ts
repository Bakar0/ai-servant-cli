// Reading a skill directory as Claude Code reads it: the file that makes a directory a skill, the
// frontmatter fields that decide whether the agent is ever shown it, and finding those directories
// in a tree whose shape nobody controls.
//
// It lives apart from the store because the store is not the only place skills come from. A skill
// inside an enabled plugin is read with exactly these rules and belongs to no source servant
// manages, so the reading has to be a thing on its own rather than a private detail of `skills.ts`.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** The file that makes a directory a skill. */
export const SKILL_FILE = "SKILL.md";

/** Directory names never walked into when looking for skills: dependency trees and git metadata. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

export function parseFrontmatter(doc: string): Record<string, unknown> | null {
  const match = doc.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = Bun.YAML.parse(match[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Malformed frontmatter is the source's problem, not a reason to fail a listing.
    return null;
  }
}

/** A skill's stated purpose, from its YAML frontmatter. */
export function readFrontmatterDescription(doc: string): string {
  const value = parseFrontmatter(doc)?.description;
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Whether the agent ever sees this skill offered, from its YAML frontmatter.
 *
 * `disable-model-invocation: true` makes Claude Code omit the skill from the listing it keeps in
 * context — verified over 396 sessions on one machine: zero appearances, ever. Absent or malformed
 * frontmatter reads as invocable, which is the default the agent actually applies.
 *
 * This is the difference between *reachable* and *model-visible*, and it is not cosmetic: on one
 * plugin here the two counts are 35 and 20. A report that conflates them overstates what a session
 * pays by roughly 2.5x — the same direction the store-only listing was already wrong in.
 */
export function readModelInvocable(doc: string | null): boolean {
  return parseFrontmatter(doc ?? "")?.["disable-model-invocation"] !== true;
}

/**
 * Every skill directory under `root`, as paths relative to it — `"."` when `root` is itself a skill.
 *
 * It looks for `SKILL.md` files rather than for directories, because the nesting is the source's
 * choice and no depth is safe to assume: one plugin here files its skills two levels down under
 * category directories, so listing `skills/*` finds five entries where there are thirty-five.
 */
export async function findSkillDirs(root: string, maxDepth: number): Promise<string[]> {
  if (!existsSync(root)) return [];
  if (existsSync(join(root, SKILL_FILE))) return ["."];
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (existsSync(join(root, child, SKILL_FILE))) found.push(child);
      else await walk(child, depth + 1);
    }
  };
  await walk("", 1);
  return found.sort();
}
