import { claudeCodeAgent } from "./claude-code.ts";
import type { CodingAgent } from "./types.ts";

const AGENTS: Record<string, CodingAgent> = {
  "claude-code": claudeCodeAgent,
};

export const DEFAULT_AGENT = "claude-code";

export function getAgent(name: string): CodingAgent {
  const agent = AGENTS[name];
  if (!agent) {
    const supported = Object.keys(AGENTS).join(", ");
    throw new Error(`Unknown agent "${name}". Supported: ${supported}.`);
  }
  return agent;
}
