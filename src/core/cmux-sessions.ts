import { homedir } from "node:os";
import { join } from "node:path";

export type CmuxAgentLifecycle = "running" | "idle" | "needsInput" | "unknown";

export interface CmuxLiveState {
  surfaceId: string | null;
  workspaceId: string | null;
  agentLifecycle: CmuxAgentLifecycle | null;
  lastSubtitle: string | null;
  isRestorable: boolean;
  updatedAtMs: number | null;
}

function cmuxSessionsPath(): string {
  const override = process.env.CMUX_HOOK_SESSIONS_PATH;
  if (override && override.length > 0) return override;
  return join(homedir(), ".cmuxterm", "claude-hook-sessions.json");
}

function coerceLifecycle(value: unknown): CmuxAgentLifecycle | null {
  if (value === "running" || value === "idle" || value === "needsInput" || value === "unknown") {
    return value;
  }
  return null;
}

export async function readCmuxLiveStates(): Promise<Map<string, CmuxLiveState>> {
  const path = cmuxSessionsPath();
  const out = new Map<string, CmuxLiveState>();
  const file = Bun.file(path);
  if (!(await file.exists())) return out;

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return out;
  }

  const entries = extractEntries(parsed);
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as {
      sessionId?: unknown;
      surfaceId?: unknown;
      workspaceId?: unknown;
      agentLifecycle?: unknown;
      lastSubtitle?: unknown;
      isRestorable?: unknown;
      updatedAt?: unknown;
    };
    if (typeof rec.sessionId !== "string" || rec.sessionId.length === 0) continue;
    out.set(rec.sessionId, {
      surfaceId: typeof rec.surfaceId === "string" ? rec.surfaceId : null,
      workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : null,
      agentLifecycle: coerceLifecycle(rec.agentLifecycle),
      lastSubtitle: typeof rec.lastSubtitle === "string" ? rec.lastSubtitle : null,
      isRestorable: rec.isRestorable === true,
      updatedAtMs: typeof rec.updatedAt === "number" ? rec.updatedAt * 1000 : null,
    });
  }
  return out;
}

function extractEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { sessions?: unknown };
    if (Array.isArray(obj.sessions)) return obj.sessions;
    // map shape: { "<id>": {...} }
    return Object.values(parsed as Record<string, unknown>);
  }
  return [];
}
