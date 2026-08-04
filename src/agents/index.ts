import { claudeCodeAgent } from "./claude-code.ts";
import { codexAgent } from "./codex.ts";
import type { AgentBackend } from "./types.ts";

const AGENTS: Record<string, AgentBackend> = {
  "claude-code": claudeCodeAgent,
  codex: codexAgent,
};

export const DEFAULT_AGENT = "claude-code";

export function getAgent(name: string): AgentBackend {
  const agent = AGENTS[name];
  if (!agent) {
    const supported = Object.keys(AGENTS).join(", ");
    throw new Error(`Unknown agent "${name}". Supported: ${supported}.`);
  }
  return agent;
}

/** Alias for {@link getAgent} that reads better where the full backend surface is used. */
export const getBackend = getAgent;
