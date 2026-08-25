import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TEMPLATES } from "../templates/index.generated.ts";
import { contentStamp } from "./content-stamp.ts";
import { ensureProjectIndex, renderWorkspaceKnowledgeSection } from "./knowledge.ts";
import { aiServantRoot, workspacePath, workspacesRoot } from "./paths.ts";
import {
  renderAgentSkillsBlock,
  renderDomainDoc,
  renderIssueTrackerDoc,
  renderTriageLabelsDoc,
} from "./skills-config.ts";
import { parseWorktreeDirName, reposRoot } from "./worktree-naming.ts";

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
// decisions live in docs/adr/ ADRs, operating instructions in CLAUDE.md.
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

// Static scaffold files seeded once when a workspace is created. Only written if missing so user
// edits are never clobbered. Tasks/plans no longer live as files — they are tickets on the
// workspace's board (see docs/agents/issue-tracker.md, generated per workspace below). ADRs live in
// docs/adr/.
const SCAFFOLD_FILES: ReadonlyArray<readonly [string, string]> = [
  ["GOAL.md", GOAL_PLACEHOLDER],
  ["CONTEXT.md", "# Context\n\nShared language / domain glossary for this workspace.\n"],
];

// The contract servant publishes to whatever instruction set is installed (docs/agents/*).
// Parameterized by workspace name, so generated in ensureWorkspaceDir rather than listed
// statically. Rewritten when their content stamp moves — see writeStamped.
function skillsConfigFiles(workspace: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["docs/agents/issue-tracker.md", renderIssueTrackerDoc(workspace)],
    ["docs/agents/domain.md", renderDomainDoc()],
    ["docs/agents/triage-labels.md", renderTriageLabelsDoc()],
  ];
}

async function writeIfMissing(path: string, body: string): Promise<void> {
  try {
    await readFile(path);
    return;
  } catch {
    // missing, will write
  }
  await writeFile(path, body);
}

/**
 * Write a generated agent doc, refreshing it whenever its content has moved.
 *
 * Used for every stamped doc servant generates into a workspace: the `docs/agents/*` board contract
 * and the two agent-conventions docs. These are the *only* scaffold files that are not
 * write-if-missing, and the exception is deliberate (ADR-0011): they describe how to operate the
 * tracker and how to work here, so a workspace created before a change would otherwise keep
 * instructing agents from the old prose forever. The stamped first line means an unstamped doc —
 * every workspace predating this — never compares equal, and so is always replaced.
 */
async function writeStamped(path: string, desired: string): Promise<void> {
  const existing = await readFileOr(path, "");
  if (existing === desired) return;
  await writeFile(path, desired);
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
  for (const [rel, body] of skillsConfigFiles(name)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeStamped(full, body);
  }
  // ADRs live here (created lazily by /domain-modeling); seed the dir so the layout is visible.
  await mkdir(join(dir, "docs", "adr"), { recursive: true });
  await ensureWorkspaceSettings(dir);
  await syncWorkspaceConventions(name);
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

// ---------------------------------------------------------------------------------------------
// One source, two renderings.
//
// A workspace ships two agent-conventions docs because the two backends read different files:
// Claude reads CLAUDE.md and resolves `@path` imports, Codex reads AGENTS.md as plain text and has
// no import mechanism at all. That is the *only* difference between them. Everything that decides
// what a session here believes — servant's conventions prose, this workspace's GOAL.md, the
// docs/agents pointer block, the inlined knowledge index — is gathered once, into
// `WorkspaceConventions`, and each renderer only chooses how to deliver it.
//
// So the size difference between the two files is inlining, not divergence, and adding a section to
// one without the other is not something a renderer can do by accident.
// ---------------------------------------------------------------------------------------------

/** servant's conventions prose exactly as it ships in the binary — before any fine-tune overlay. */
function bundledConventions(): string {
  return TEMPLATES.find((t) => t.rel === "servant_root/CLAUDE.md")?.content ?? "";
}

const CONVENTIONS_STAMP_PREFIX = "<!-- servant:conventions v=";

/**
 * The version line both docs open with — deliberately the *same* value in each, since that is the
 * claim the stamp exists to make: these are two renderings of one source.
 *
 * It stamps servant's bundled conventions prose, NOT the rendered file. Unlike `docs/agents/*`
 * (which stamp their whole body, because their whole body is servant's), these two docs also carry
 * workspace-owned content — GOAL.md, the knowledge index — that churns on every repo mount and
 * every note captured. A whole-file digest here would move constantly, differ between any two
 * workspaces, and differ between the Claude twin and the Codex twin, which is all three of the
 * questions the stamp is supposed to answer. Stamping the base also keeps it comparable across
 * machines whose users have different fine-tune overlays (`fine-tune.ts`): the stamp names the
 * version of servant's prose, and the overlay is by definition not that.
 *
 * Nothing reads the stamp to decide whether to rewrite — `writeStamped` compares full content — so
 * the narrower stamp costs no refresh accuracy. The docs/agents pointer block is not hashed either;
 * it points at three documents that carry their own stamps.
 */
function conventionsStampLine(): string {
  return `${CONVENTIONS_STAMP_PREFIX}${contentStamp(bundledConventions())} — generated by servant; edits here are overwritten -->`;
}

// Explains to a reader of AGENTS.md why its content is inlined rather than imported.
const WORKSPACE_AGENTS_MD_HEADER =
  "<!-- This is the Codex-facing twin of CLAUDE.md. Codex reads AGENTS.md and has no @-import\n" +
  "     mechanism, so the servant-root conventions and this workspace's GOAL.md are inlined below\n" +
  "     (CLAUDE.md @-imports them instead). Same substance, one source. -->";

// What CLAUDE.md @-imports and AGENTS.md inlines: the servant-root conventions doc and the
// workspace's own GOAL.md. We do NOT @-import the knowledge store (`~/.ai_servant/knowledge/*`) —
// those files are outside the workspace cwd and Claude Code gates external imports behind a
// per-spawn trust prompt. The knowledge index is inlined into both docs instead.
const CLAUDE_IMPORTS = ["@../../CLAUDE.md", "@GOAL.md"];

interface WorkspaceConventions {
  /** servant's conventions prose, composed on disk (base + any fine-tune overlay). */
  readonly rootConventions: string;
  /** This workspace's GOAL.md. */
  readonly goal: string;
  /** The docs/agents pointer block. */
  readonly agentSkills: string;
  /** The inlined knowledge index — topic tags plus a note list per mounted repo. */
  readonly knowledge: string;
}

async function readFileOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

async function gatherWorkspaceConventions(
  workspace: string,
  repoSubdirs: readonly string[],
): Promise<WorkspaceConventions> {
  return {
    rootConventions: (await readFileOr(join(aiServantRoot(), "CLAUDE.md"), "")).trim(),
    goal: (await readFileOr(join(workspacePath(workspace), "GOAL.md"), "")).trim(),
    agentSkills: renderAgentSkillsBlock(workspace).trim(),
    knowledge: (await renderWorkspaceKnowledgeSection(repoSubdirs)).trimEnd(),
  };
}

/** The Claude rendering: import what can be imported, inline the rest. */
function renderClaudeMd(src: WorkspaceConventions): string {
  const sections = [
    conventionsStampLine(),
    CLAUDE_IMPORTS.join("\n"),
    src.agentSkills,
    src.knowledge,
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/** The Codex rendering: identical substance, everything inlined. */
function renderAgentsMd(src: WorkspaceConventions): string {
  const sections = [conventionsStampLine(), WORKSPACE_AGENTS_MD_HEADER];
  if (src.rootConventions) sections.push(src.rootConventions);
  if (src.goal) sections.push(`# Workspace goal (GOAL.md)\n\n${src.goal}`);
  sections.push(src.agentSkills, src.knowledge);
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/**
 * Rewrite the workspace CLAUDE.md — the Claude-facing rendering of the shared source. Creates any
 * missing per-repo knowledge index so project knowledge follows the repo. Idempotent — safe to call
 * on every spawn / repo add / repo rm.
 */
export async function syncWorkspaceClaudeMd(workspace: string): Promise<void> {
  const repoSubdirs = await mountedRepoSubdirs(workspace);
  for (const repo of repoSubdirs) await ensureProjectIndex(repo);
  const src = await gatherWorkspaceConventions(workspace, repoSubdirs);
  await writeStamped(join(workspacePath(workspace), "CLAUDE.md"), renderClaudeMd(src));
}

/**
 * Rewrite the workspace AGENTS.md — the Codex-facing rendering of the same source. Idempotent.
 */
export async function syncWorkspaceAgentsMd(workspace: string): Promise<void> {
  const repoSubdirs = await mountedRepoSubdirs(workspace);
  for (const repo of repoSubdirs) await ensureProjectIndex(repo);
  const src = await gatherWorkspaceConventions(workspace, repoSubdirs);
  await writeStamped(join(workspacePath(workspace), "AGENTS.md"), renderAgentsMd(src));
}

/**
 * Sync both agent-conventions docs for the workspace so it works under either backend: CLAUDE.md
 * (Claude, via @-imports) and AGENTS.md (Codex, inlined). Called on every spawn / repo add / repo rm.
 */
export async function syncWorkspaceConventions(workspace: string): Promise<void> {
  await syncWorkspaceClaudeMd(workspace);
  await syncWorkspaceAgentsMd(workspace);
}

// Records which agent backend a workspace was last spawned with, so a later `servant spawn` (or a
// `/servant:handoff` that shells out to `servant spawn`) reuses it instead of silently reverting to
// the default. Lives in the workspace's own `.servant/` state dir.
function workspaceAgentMarkerPath(workspace: string): string {
  return join(workspacePath(workspace), ".servant", "agent");
}

/** The backend name recorded for this workspace, or null if none has been recorded yet. */
export async function readWorkspaceAgent(workspace: string): Promise<string | null> {
  const raw = (await readFileOr(workspaceAgentMarkerPath(workspace), "")).trim();
  return raw.length > 0 ? raw : null;
}

/** Record the backend name this workspace is being driven with (idempotent). */
export async function writeWorkspaceAgent(workspace: string, agent: string): Promise<void> {
  const path = workspaceAgentMarkerPath(workspace);
  if ((await readWorkspaceAgent(workspace)) === agent) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${agent}\n`);
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
