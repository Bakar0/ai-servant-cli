import { claudeCommandsDir } from "../core/paths.ts";
import { shellSingleQuote } from "../core/shell.ts";
import type {
  AgentBackend,
  ExtractionArgvOptions,
  JudgeArgvOptions,
  LaunchOptions,
} from "./types.ts";

export const claudeCodeAgent: AgentBackend = {
  name: "claude-code",
  launchCommand(_cwd: string, opts?: LaunchOptions): string {
    const addDirs = (opts?.addDirs ?? []).filter((d) => d.trim().length > 0);
    const prompt = opts?.prompt?.trim();
    const sessionName = opts?.sessionName?.trim();
    const permissionMode = opts?.permissionMode?.trim();
    const parts = ["claude"];
    if (sessionName) parts.push("--name", shellSingleQuote(sessionName));
    if (permissionMode) parts.push("--permission-mode", shellSingleQuote(permissionMode));
    // There is no `--fast`: fast mode is a setting, and `--settings` loads *additional* settings
    // rather than replacing the sources — so the session still gets the user's own hooks,
    // permissions and status line, with this on top.
    if (opts?.fastMode) parts.push("--settings", shellSingleQuote('{"fastMode":true}'));
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

  resumeCommand(sessionId: string, prompt?: string): string {
    const base = `claude --resume ${shellSingleQuote(sessionId)}`;
    const trimmed = prompt?.trim();
    return trimmed ? `${base} ${shellSingleQuote(trimmed)}` : base;
  },

  resumeArgv(sessionId: string, prompt?: string): string[] {
    const argv = ["claude", "--resume", sessionId];
    const trimmed = prompt?.trim();
    if (trimmed) argv.push(trimmed);
    return argv;
  },

  conventions: { filename: "CLAUDE.md", supportsImports: true },

  prompts: {
    dir: () => claudeCommandsDir(),
    // Claude namespaces commands by directory (`servant/goal.md` → `/servant:goal`); the caller
    // writes under `<dir>/servant/`, so the filename itself is just `<id>.md`.
    filename: (commandId: string) => `${commandId}.md`,
  },

  headless: {
    selfExclusion: "session-id",
    // `--dangerously-skip-permissions`: the headless pass reads the transcript, writes notes, and
    // runs `servant … --reconcile` unattended; in `-p` mode any tool needing approval is auto-DENIED
    // (no way to prompt), which would silently produce zero notes. Acceptable — it only touches the
    // servant's own store. `--add-dir` brings that store (outside cwd) into tool scope.
    extractionArgv(prompt: string, opts: ExtractionArgvOptions): string[] {
      return [
        "claude",
        "-p",
        prompt,
        ...opts.modelArgs,
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
        "--add-dir",
        opts.addDir,
      ];
    },
    judgeArgv(prompt: string, opts: JudgeArgvOptions): string[] {
      return [
        "claude",
        "-p",
        prompt,
        ...opts.modelArgs,
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
        "--session-id",
        opts.sessionId,
        "--add-dir",
        opts.addDir,
      ];
    },
  },
};
