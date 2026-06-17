import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ensureProjectIndex, renderWorkspaceKnowledgeSection } from "./knowledge.ts";
import { workspacePath, workspacesRoot } from "./paths.ts";
import { parseWorktreeDirName, reposRoot } from "./worktree-naming.ts";

// Imports at the top of a workspace's CLAUDE.md: the servant-root conventions doc and the
// workspace's own GOAL.md. Both are auto-loaded every session. We do NOT @-import the
// knowledge store (`~/.ai_servant/knowledge/*`) — those files are outside the workspace
// cwd and Claude Code gates external imports behind a per-spawn trust prompt. Instead the
// knowledge index is inlined into the body below (see renderWorkspaceKnowledgeSection).
const WORKSPACE_CLAUDE_MD_BASE = ["@../../CLAUDE.md", "@GOAL.md"];

// SessionEnd hook that enqueues a knowledge-extraction job when a servant session ends.
// It MUST live in the workspace's own `.claude/settings.json`: Claude Code discovers
// slash commands by walking up the directory tree (so they resolve from the servant
// root) but it does NOT discover settings.json that far up — it only reads the project
// cwd's `.claude/settings.json`. `servant spawn` launches the agent with cwd = the
// workspace dir, so scaffolding the hook here is what makes it fire. (Verified 2026-06-16:
// an upward `~/.ai_servant/.claude/settings.json` does not fire; a per-workspace one does.)
const SESSION_END_HOOK = {
  type: "command",
  command: "servant extract-memories --from-hook",
  timeout: 15,
};

// Marker embedded in the placeholder GOAL.md. Its presence means the workspace's
// goal has not been defined yet; `/servant:goal` removes it once the user approves a goal.
export const GOAL_UNFILLED_MARKER = "servant:goal:unfilled";

// Placeholder GOAL.md. Intent-only (mission / KPIs / out-of-scope); architecture
// decisions live in context/ ADRs, operating instructions in CLAUDE.md.
const GOAL_PLACEHOLDER = `# Goal

> [!NOTE]
> Not yet defined. Run \`/servant:goal\` to fill this in. <!-- ${GOAL_UNFILLED_MARKER} -->

## Mission
_The guiding beacon: what this workspace is about, and why. One or two sentences — not a spec._

## KPIs / success signals
_Concrete, verifiable signals that it's working (a behavior works, a test passes, a number moves)._

## Out of scope
_Anything explicitly NOT part of this workspace._
`;

// Scaffold files seeded once when a workspace is created. Only written if missing
// so user edits are never clobbered. Layout matches `~/.ai_servant/CLAUDE.md`.
const SCAFFOLD_FILES: ReadonlyArray<readonly [string, string]> = [
  ["GOAL.md", GOAL_PLACEHOLDER],
  ["CONTEXT.md", "# Context\n\nShared language / domain glossary for this workspace.\n"],
  ["briefs/INDEX.md", "# Briefs\n"],
  ["plans/INDEX.md", "# Plans\n"],
  ["context/INDEX.md", "# Context\n"],
];

async function writeIfMissing(path: string, body: string): Promise<void> {
  try {
    await readFile(path);
    return;
  } catch {
    // missing, will write
  }
  await writeFile(path, body);
}

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function assertValidWorkspaceName(name: string): void {
  if (!name) throw new Error("Workspace name is required.");
  if (name === "." || name === "..") {
    throw new Error(`Invalid workspace name: "${name}".`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`Workspace name must not contain path separators: "${name}".`);
  }
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid workspace name "${name}". Allowed: letters, digits, "_", ".", "-"; must not start with "." or "-".`,
    );
  }
}

export async function ensureWorkspaceDir(name: string): Promise<string> {
  assertValidWorkspaceName(name);
  const dir = workspacePath(name);
  await mkdir(dir, { recursive: true });
  for (const [rel, body] of SCAFFOLD_FILES) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeIfMissing(full, body);
  }
  await ensureWorkspaceSettings(dir);
  await syncWorkspaceClaudeMd(name);
  return dir;
}

/**
 * Ensure the workspace's `.claude/settings.json` carries the SessionEnd extraction hook.
 * Merges the hook into any existing settings (preserving other keys / hook events) and is
 * idempotent — only rewrites when the content actually changes.
 */
export async function ensureWorkspaceSettings(workspaceDir: string): Promise<void> {
  const path = join(workspaceDir, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or unparseable — start fresh
  }
  const hooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};
  hooks.SessionEnd = [{ hooks: [SESSION_END_HOOK] }];
  settings.hooks = hooks;
  const desired = `${JSON.stringify(settings, null, 2)}\n`;
  if (existing === desired) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, desired);
}

/** Unique repo subdirs mounted under the workspace's repos/ (the worktree-naming segment). */
export async function mountedRepoSubdirs(workspace: string): Promise<string[]> {
  const root = reposRoot(workspace);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const subdirs = new Set<string>();
  for (const entry of entries) {
    const parsed = parseWorktreeDirName(entry);
    if (parsed) subdirs.add(parsed.repoSubdir);
  }
  return [...subdirs].toSorted();
}

async function buildWorkspaceClaudeMd(repoSubdirs: readonly string[]): Promise<string> {
  const header = `${WORKSPACE_CLAUDE_MD_BASE.join("\n")}\n`;
  const knowledge = await renderWorkspaceKnowledgeSection(repoSubdirs);
  return `${header}\n${knowledge}`;
}

/**
 * Rewrite the workspace CLAUDE.md: the base imports (servant-root conventions + GOAL.md)
 * followed by the inlined knowledge index — the topic tag directory plus a per-repo note
 * list for every mounted repo. Creates any missing per-repo index in the store so project
 * knowledge follows the repo. Inlined (not @-imported) to avoid Claude Code's external-
 * import trust prompt. Idempotent — safe to call on every spawn / repo add / repo rm.
 */
export async function syncWorkspaceClaudeMd(workspace: string): Promise<void> {
  const repoSubdirs = await mountedRepoSubdirs(workspace);
  for (const repo of repoSubdirs) await ensureProjectIndex(repo);
  const claudeMdPath = join(workspacePath(workspace), "CLAUDE.md");
  const desired = await buildWorkspaceClaudeMd(repoSubdirs);
  let existing: string | null = null;
  try {
    existing = await readFile(claudeMdPath, "utf8");
  } catch {
    // missing, will write
  }
  if (existing !== desired) await writeFile(claudeMdPath, desired);
}

// True when the workspace's goal has not been defined yet (GOAL.md still carries the
// unfilled marker, or is missing). Drives whether a freshly spawned agent is asked to
// run `/servant:goal` first. Independent of how the workspace was created (e.g. with `-r`).
export async function isGoalUnfilled(name: string): Promise<boolean> {
  const path = join(workspacePath(name), "GOAL.md");
  try {
    const body = await readFile(path, "utf8");
    return body.includes(GOAL_UNFILLED_MARKER);
  } catch {
    return true;
  }
}

export function detectWorkspaceNameFromCwd(cwd: string, root: string): string | null {
  const rel = relative(resolve(root), resolve(cwd));
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  const first = rel.split(sep)[0];
  if (!first) return null;
  try {
    assertValidWorkspaceName(first);
  } catch {
    return null;
  }
  return first;
}

export async function resolveWorkspaceName(provided: string | undefined): Promise<string>;
export async function resolveWorkspaceName(
  provided: string | undefined,
  opts: { allowUnresolved: true },
): Promise<string | null>;
export async function resolveWorkspaceName(
  provided: string | undefined,
  opts?: { allowUnresolved?: boolean },
): Promise<string | null> {
  if (provided) {
    assertValidWorkspaceName(provided);
    return provided;
  }

  const root = workspacesRoot();
  const fromCwd = detectWorkspaceNameFromCwd(process.cwd(), root);
  if (fromCwd) return fromCwd;

  const { getCurrentCmuxWorkspaceTitle } = await import("../terminals/cmux.ts");
  const inCmux = Boolean(process.env.CMUX_WORKSPACE_ID);
  let cmuxTitle: string | null = null;
  if (inCmux) {
    cmuxTitle = await getCurrentCmuxWorkspaceTitle();
    if (cmuxTitle) {
      try {
        assertValidWorkspaceName(cmuxTitle);
        if (existsSync(workspacePath(cmuxTitle))) return cmuxTitle;
      } catch {
        // fall through to error
      }
    }
  }

  if (opts?.allowUnresolved) return null;

  const tried = [`cwd ${process.cwd()} is not under ${root}/<name>`];
  if (!inCmux) {
    tried.push("cmux workspace identity: not running inside cmux");
  } else if (cmuxTitle === null) {
    tried.push("cmux workspace identity: could not resolve current cmux workspace");
  } else {
    tried.push(`cmux workspace "${cmuxTitle}": no matching folder at ${workspacePath(cmuxTitle)}`);
  }
  throw new Error(
    `Could not auto-detect workspace. Tried:\n  - ${tried.join("\n  - ")}\nPass --workspace <name> explicitly.`,
  );
}
