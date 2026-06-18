import { resolve } from "node:path";

// Deterministic, checkable instruction rules drawn straight from the workspace CLAUDE.md.
// Each rule scans the structured tool calls of a session and flags concrete violations.
// Designed as a list so new rules are a one-line addition — no parsing of free-form prose.

/** A single tool invocation pulled from an assistant turn's `tool_use` block. */
export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/** Everything a rule needs to judge a session, assembled by the metrics extractor. */
export interface RuleContext {
  toolCalls: ToolCall[];
  /** The session's launch cwd — used to tell "inside a repo worktree" from the workspace root. */
  launchCwd: string;
}

export interface RuleViolation {
  /** Stable rule id (kebab-case). */
  rule: string;
  /** Human-readable specifics, e.g. the offending path. */
  detail: string;
}

interface Rule {
  id: string;
  description: string;
  check(ctx: RuleContext): RuleViolation[];
}

// Path segments that mark an in-repo planning artifact. The workspace CLAUDE.md is explicit:
// plans/ADRs/scratch live in the *workspace*, never inside the repo being edited.
const IN_REPO_PLANNING_RE = /(^|\/)(docs\/plans|\.scratch)(\/|$)|(^|\/)PLAN\.md$/i;

function fileTarget(call: ToolCall): string | null {
  const p = call.input.file_path ?? call.input.path ?? call.input.notebook_path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

// Servant worktrees live under `<workspace>/repos/<repo>__<branch>/` (the `__` divider convention).
// A path inside one of those is "repo land" — where planning artifacts must never be written.
const REPO_WORKTREE_RE = /\/repos\/[^/]+__[^/]+(\/|$)/;

/** True when `path` resolves to somewhere inside a `repos/<repo>__<branch>/` worktree. */
function isInsideRepoWorktree(launchCwd: string, path: string): boolean {
  const abs = resolve(launchCwd || "/", path);
  return REPO_WORKTREE_RE.test(abs);
}

const RULES: readonly Rule[] = [
  {
    id: "no-plans-in-repo",
    description:
      "Never Write/Edit a planning artifact (docs/plans/, PLAN.md, .scratch/) inside a repo worktree — those belong in the workspace.",
    check(ctx) {
      const out: RuleViolation[] = [];
      for (const call of ctx.toolCalls) {
        if (call.tool !== "Write" && call.tool !== "Edit" && call.tool !== "NotebookEdit") continue;
        const target = fileTarget(call);
        if (!target) continue;
        if (!IN_REPO_PLANNING_RE.test(target)) continue;
        if (!isInsideRepoWorktree(ctx.launchCwd, target)) continue;
        out.push({ rule: "no-plans-in-repo", detail: `${call.tool} ${target}` });
      }
      return out;
    },
  },
];

/** Run every checkable rule against a session's tool calls. */
export function checkRules(ctx: RuleContext): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const rule of RULES) out.push(...rule.check(ctx));
  return out;
}

/** The rule catalog (id + description), for help/listing. */
export function ruleCatalog(): { id: string; description: string }[] {
  return RULES.map((r) => ({ id: r.id, description: r.description }));
}
