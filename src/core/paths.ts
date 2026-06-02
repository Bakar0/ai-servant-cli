import { homedir } from "node:os";
import { join } from "node:path";

export function aiServantRoot(): string {
  return join(homedir(), ".ai_servant");
}

export function workspacePath(name: string): string {
  return join(aiServantRoot(), name);
}
