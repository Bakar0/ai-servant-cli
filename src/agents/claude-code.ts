import { shellSingleQuote } from "../core/shell.ts";
import type { CodingAgent, LaunchOptions } from "./types.ts";

export const claudeCodeAgent: CodingAgent = {
  name: "claude-code",
  launchCommand(_cwd: string, opts?: LaunchOptions): string {
    const prompt = opts?.prompt?.trim();
    if (!prompt) return "claude";
    return `claude ${shellSingleQuote(prompt)}`;
  },
};
