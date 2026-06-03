import { homedir } from "node:os";
import { join } from "node:path";

export function aiServantRoot(): string {
  const override = process.env.AI_SERVANT_ROOT;
  if (override && override.length > 0) return override;
  return join(homedir(), ".ai_servant");
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
