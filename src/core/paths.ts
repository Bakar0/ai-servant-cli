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

export function discoveryCachePath(): string {
  return join(aiServantRoot(), ".cache", "repo-discovery.json");
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
