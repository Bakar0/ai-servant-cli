import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Walking a Talk session's scope. Shared by the startup tree and the agent's own grep so both see
// exactly the same set of files — what the agent can search is what it was told exists.

/** Directories the agent should never be shown or search: not signal, and huge. */
export const TALK_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "coverage",
  ".next",
  ".venv",
  "__pycache__",
]);

export interface WalkLimits {
  /** Directory levels to descend, 1 being the root itself. Unlimited when omitted. */
  maxDepth?: number | undefined;
  /** Stop once this many files are found. Unlimited when omitted. */
  maxEntries?: number | undefined;
}

/** File paths under `root`, relative and sorted, skipping the ignored directories. */
export async function walkScopeFiles(root: string, limits: WalkLimits = {}): Promise<string[]> {
  const maxDepth = limits.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxEntries = limits.maxEntries ?? Number.POSITIVE_INFINITY;
  const found: string[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.length >= maxEntries) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= maxEntries) return;
      if (TALK_IGNORED_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel, depth + 1);
      else found.push(rel);
    }
  }

  await walk(root, "", 1);
  return found;
}
