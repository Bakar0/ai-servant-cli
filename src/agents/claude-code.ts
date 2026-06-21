import { shellSingleQuote } from "../core/shell.ts";
import type { CodingAgent, LaunchOptions } from "./types.ts";

export const claudeCodeAgent: CodingAgent = {
  name: "claude-code",
  launchCommand(_cwd: string, opts?: LaunchOptions): string {
    const addDirs = (opts?.addDirs ?? []).filter((d) => d.trim().length > 0);
    const prompt = opts?.prompt?.trim();
    const parts = ["claude"];
    // `--add-dir <directories...>` is variadic — it greedily consumes every following arg until
    // the next option or a `--`. Pass all dirs to one flag, then terminate with `--` so the
    // positional prompt is parsed as the prompt and not swallowed as another directory.
    if (addDirs.length > 0) parts.push("--add-dir", ...addDirs.map(shellSingleQuote));
    if (prompt) {
      if (addDirs.length > 0) parts.push("--");
      parts.push(shellSingleQuote(prompt));
    }
    return parts.join(" ");
  },
};
