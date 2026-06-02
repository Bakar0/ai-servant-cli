import type { CodingAgent } from "./types.ts";

export const claudeCodeAgent: CodingAgent = {
  name: "claude-code",
  launchCommand(_cwd: string): string {
    return "claude";
  },
};
