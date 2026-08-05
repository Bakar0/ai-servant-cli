import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Process-wide root override, set by the `--root` flag (and by tests). There is no
// AI_SERVANT_ROOT env var and no registry — the root is `~/.ai_servant` unless a command
// is explicitly pointed elsewhere with `--root` (used for throwaway/test setups).
let rootOverride: string | null = null;

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Point all path helpers at a specific root for the rest of this process (or null to reset). */
export function setRootOverride(path: string | null): void {
  rootOverride = path && path.length > 0 ? resolve(expandHome(path)) : null;
}

/** Convenience for command `run()`s: apply `--root` if it was passed. */
export function applyRootOverride(root: unknown): void {
  if (typeof root === "string" && root.length > 0) setRootOverride(root);
}

export function aiServantRoot(): string {
  return rootOverride ?? join(homedir(), ".ai_servant");
}

export function workspacesRoot(): string {
  return join(aiServantRoot(), "workspaces");
}

export function workspacePath(name: string): string {
  return join(workspacesRoot(), name);
}

/** The workspace's declarative architecture source — the single file feeding the dashboard's
 * architecture diagram and component map (human-maintained). */
export function workspaceArchitecturePath(name: string): string {
  return join(workspacePath(name), "context", "architecture.yaml");
}

/** The workspace's declarative delivery-roadmap source — the agent-maintained phase timeline
 * feeding the dashboard's "where we are" panel. */
export function workspaceRoadmapPath(name: string): string {
  return join(workspacePath(name), "context", "roadmap.yaml");
}

export function configPath(): string {
  return join(aiServantRoot(), "config.json");
}

export function cacheDir(): string {
  return join(aiServantRoot(), ".cache");
}

export function discoveryCachePath(): string {
  return join(cacheDir(), "repo-discovery.json");
}

/** User-owned fine-tune overlays (one file per tunable aspect), sibling to workspaces/. */
export function fineTuneDir(): string {
  return join(aiServantRoot(), "fine-tune");
}

export function fineTuneAspectPath(id: string): string {
  return join(fineTuneDir(), `${id}.md`);
}

/**
 * The servant hub: a clone of the majordomo repo (issue tracker on GitHub +
 * `knowledge/` notes on disk). The git repo lives here, at the hub root — knowledge/
 * is just a tracked subdirectory of it.
 */
export function hubRoot(): string {
  return join(aiServantRoot(), "majordomo");
}

/** Default hub repo slug (owner/name); overridable via config `hubRepo`. */
export const DEFAULT_HUB_REPO = "Barak-Zen/majordomo";

/** HTTPS git URL for a `owner/name` hub slug. */
export function hubRemoteUrl(slug: string = DEFAULT_HUB_REPO): string {
  return `https://github.com/${slug}.git`;
}

/** Durable, git-tracked knowledge store — a subdirectory of the hub clone. */
export function knowledgeRoot(): string {
  return join(hubRoot(), "knowledge");
}

export function knowledgeIndexPath(): string {
  return join(knowledgeRoot(), "INDEX.md");
}

export function knowledgeProjectsDir(): string {
  return join(knowledgeRoot(), "projects");
}

export function knowledgeProjectDir(repo: string): string {
  return join(knowledgeProjectsDir(), repo);
}

export function knowledgeProjectIndexPath(repo: string): string {
  return join(knowledgeProjectDir(repo), "INDEX.md");
}

export function knowledgeTopicsDir(): string {
  return join(knowledgeRoot(), "topics");
}

/** Durable, git-tracked insights store (metrics + change ledger), sibling to knowledge/. */
export function insightsRoot(): string {
  return join(aiServantRoot(), "insights");
}

/** One deterministic metrics record per session lives here (dedup key = session id). */
export function insightsMetricsDir(): string {
  return join(insightsRoot(), "metrics");
}

/** Append-only ledger of instruction/asset changes (the before/after primitive). */
export function insightsChangesPath(): string {
  return join(insightsRoot(), "changes.jsonl");
}

/**
 * One qualitative judgment record per session lives here (dedup key = session id), a sibling area
 * to metrics/ inside the same git-tracked insights store.
 */
export function insightsJudgmentsDir(): string {
  return join(insightsRoot(), "judgments");
}

/** Thin regenerated digest snapshot, like knowledge/INDEX.md. */
export function insightsIndexPath(): string {
  return join(insightsRoot(), "INDEX.md");
}

/**
 * The rendered `--deep` HTML dashboard. A regenerated artifact (not part of the data record), so it
 * lives in the store area but is git-ignored — it is overwritten on every `insights --deep` run.
 */
export function insightsDashboardPath(): string {
  return join(insightsRoot(), "dashboard.html");
}

/**
 * Regenerated per-workspace HTML dashboards live here — a git-ignored sibling area inside the
 * insights store, consistent with where `insights --deep` writes its dashboard. Overwritten on
 * every `servant dashboard` run, so it is an artifact, not a data record.
 */
export function workspaceDashboardsDir(): string {
  return join(insightsRoot(), "dashboards");
}

/** The rendered dashboard for one workspace (`<name>.html`). */
export function workspaceDashboardPath(name: string): string {
  return join(workspaceDashboardsDir(), `${name}.html`);
}

/** Queue of pending session-end extraction jobs (one JSON object per line). */
export function extractQueuePath(): string {
  return join(cacheDir(), "extract-queue.jsonl");
}

/** Lockfile guaranteeing only one drainer runs at a time. */
export function extractLockPath(): string {
  return join(cacheDir(), "extract-queue.lock");
}

/** Per-session "extracted up to turn N" markers (incremental extraction). */
export function extractMarkersPath(): string {
  return join(cacheDir(), "extract-markers.json");
}

/** Last drainer run status (for the `servant memories` digest). */
export function extractStatusPath(): string {
  return join(cacheDir(), "extract-status.json");
}

/** Queue of pending session-end judgment jobs (one JSON object per line). */
export function judgeQueuePath(): string {
  return join(cacheDir(), "judge-queue.jsonl");
}

/** Lockfile guaranteeing only one judgment drainer runs at a time. */
export function judgeLockPath(): string {
  return join(cacheDir(), "judge-queue.lock");
}

/** Last judgment drainer run status. */
export function judgeStatusPath(): string {
  return join(cacheDir(), "judge-status.json");
}

/**
 * Set of Claude session ids that servant itself created headlessly (memory extraction, insight
 * judging). The pull/listing side reads this to keep the servant from measuring its own runs —
 * the only self-measurement guard now that the live recorder is gone (see ADR-002).
 */
export function headlessSessionsPath(): string {
  return join(cacheDir(), "headless-sessions.json");
}

export function claudeDir(): string {
  return join(aiServantRoot(), ".claude");
}

export function claudeCommandsDir(): string {
  return join(claudeDir(), "commands");
}

export function userClaudeDir(): string {
  return join(homedir(), ".claude");
}

export function userClaudeSettingsPath(): string {
  return join(userClaudeDir(), "settings.json");
}

export function statuslineScriptPath(): string {
  return join(aiServantRoot(), "claude", "statusline.sh");
}

/** The user's real Codex home (`~/.codex`), overridable via `CODEX_HOME` for tests/CI. */
export function userCodexDir(): string {
  const override = process.env.CODEX_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".codex");
}

/** Where Codex discovers custom slash-command prompt files (top-level `*.md`). */
export function codexPromptsDir(): string {
  return join(userCodexDir(), "prompts");
}

/** Root of Codex's session (rollout) logs: `<codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
export function codexSessionsDir(): string {
  return join(userCodexDir(), "sessions");
}
