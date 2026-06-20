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

// SessionEnd hooks that fire when a servant session ends: (1) enqueue a knowledge-extraction job,
// and (2) enqueue a qualitative insight-judgment job. Both are instant enqueues that never block
// session close (a lockfile-serialized drainer does the headless work later).
//
// They MUST live in the workspace's own `.claude/settings.json`: Claude Code discovers slash
// commands by walking up the directory tree (so they resolve from the servant root) but it does
// NOT discover settings.json that far up — it only reads the project cwd's `.claude/settings.json`.
// `servant spawn` launches the agent with cwd = the workspace dir, so scaffolding the hooks here is
// what makes them fire. (Verified 2026-06-16: an upward `~/.ai_servant/.claude/settings.json` does
// not fire; a per-workspace one does.)
const SESSION_END_HOOKS = [
  { type: "command", command: "servant extract-memories --from-hook", timeout: 15 },
  { type: "command", command: "servant insights-judge --from-hook", timeout: 15 },
];

// The live telemetry recorder (`servant record`) was removed — it fed nothing user-facing and was
// redundant with the transcript (see context/adr-002-remove-live-event-recorder.md). It used to be
// wired into the hook events below on the hot path of every tool call. `ensureWorkspaceSettings`
// now *strips* it from any workspace settings that still carry it (healing old workspaces) while
// preserving the SessionEnd knowledge-extraction hook.
const DEPRECATED_RECORD_COMMAND = "servant record";
const DEPRECATED_RECORD_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "Stop",
] as const;

function isHookGroup(g: unknown): g is { hooks: unknown[] } {
  return !!g && typeof g === "object" && Array.isArray((g as { hooks?: unknown }).hooks);
}

function isCommandHook(h: unknown): h is { command?: string } {
  return !!h && typeof h === "object";
}

/** Drop any `servant record` command hook from a hooks-group array; drop groups left empty. */
function stripRecordHooks(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isHookGroup(group)) {
      out.push(group);
      continue;
    }
    const kept = group.hooks.filter(
      (h) => !(isCommandHook(h) && h.command === DEPRECATED_RECORD_COMMAND),
    );
    if (kept.length > 0) out.push({ ...group, hooks: kept });
  }
  return out;
}

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
 * Ensure the workspace's `.claude/settings.json` carries the SessionEnd knowledge-extraction hook,
 * and remove the deprecated `servant record` telemetry hooks (ADR-002) from any event they were
 * wired into — healing workspaces created before the recorder was removed. Merges into existing
 * settings (preserving other keys / user hooks) and is idempotent — only rewrites on real change.
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

  // Strip the deprecated recorder from every event it used to manage; drop keys left empty
  // (any unrelated user hooks on those events are preserved).
  for (const event of DEPRECATED_RECORD_EVENTS) {
    if (!(event in hooks)) continue;
    const cleaned = stripRecordHooks(hooks[event]);
    if (cleaned.length > 0) hooks[event] = cleaned;
    else delete hooks[event];
  }

  // SessionEnd: strip the recorder, then guarantee each managed enqueue hook is present (appending
  // any that's missing — this heals workspaces created before a hook was added). Idempotent.
  const sessionEnd = stripRecordHooks(hooks.SessionEnd);
  for (const required of SESSION_END_HOOKS) {
    const present = sessionEnd.some(
      (g) =>
        isHookGroup(g) && g.hooks.some((h) => isCommandHook(h) && h.command === required.command),
    );
    if (!present) sessionEnd.push({ hooks: [required] });
  }
  hooks.SessionEnd = sessionEnd;

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
