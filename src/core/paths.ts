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

/** Durable, git-tracked knowledge store, sibling to workspaces/. */
export function knowledgeRoot(): string {
  return join(aiServantRoot(), "knowledge");
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

/** Append-only live telemetry: one JSONL event log per session, written by `servant record`. */
export function insightsEventsDir(): string {
  return join(insightsRoot(), "events");
}

export function insightsEventLogPath(sessionId: string): string {
  return join(insightsEventsDir(), `${sessionId}.jsonl`);
}

/** Append-only ledger of instruction/asset changes (the before/after primitive). */
export function insightsChangesPath(): string {
  return join(insightsRoot(), "changes.jsonl");
}

/** Thin regenerated digest snapshot, like knowledge/INDEX.md. */
export function insightsIndexPath(): string {
  return join(insightsRoot(), "INDEX.md");
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
