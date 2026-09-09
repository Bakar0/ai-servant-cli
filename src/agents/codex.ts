import { codexPromptsDir } from "../core/paths.ts";
import { shellSingleQuote } from "../core/shell.ts";
import type {
  AgentBackend,
  ExtractionArgvOptions,
  JudgeArgvOptions,
  LaunchOptions,
} from "./types.ts";

// Keep servant's own runs out of the session store, support non-git store directories, and
// enforce workspace-write without interactive approvals. Runners use the output store as cwd.
const HEADLESS_EXEC_FLAGS = [
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "workspace-write",
  "-c",
  'approval_policy="never"',
] as const;

export const codexAgent: AgentBackend = {
  name: "codex",
  launchCommand(_cwd: string, opts?: LaunchOptions): string {
    const addDirs = (opts?.addDirs ?? []).filter((d) => d.trim().length > 0);
    const prompt = opts?.prompt?.trim();
    const parts = ["codex"];
    // Codex has no --name equivalent. Permission constraints must never be silently discarded.
    const permissionMode = opts?.permissionMode?.trim();
    if (permissionMode === "plan") {
      parts.push("--sandbox", "read-only", "--ask-for-approval", "never");
    } else if (permissionMode && permissionMode !== "default") {
      throw new Error(`Unsupported Codex permission mode: ${permissionMode}. Use plan or default.`);
    }
    // Unlike Claude's variadic `--add-dir`, Codex's `--add-dir <DIR>` takes a single directory
    // and is repeatable. A terminator also protects prompts that start with a hyphen.
    for (const dir of addDirs) parts.push("--add-dir", shellSingleQuote(dir));
    if (prompt) parts.push("--", shellSingleQuote(prompt));
    return parts.join(" ");
  },

  resumeCommand(sessionId: string, prompt?: string): string {
    const base = `codex resume ${shellSingleQuote(sessionId)}`;
    const trimmed = prompt?.trim();
    return trimmed ? `${base} -- ${shellSingleQuote(trimmed)}` : base;
  },

  resumeArgv(sessionId: string, prompt?: string): string[] {
    const argv = ["codex", "resume", sessionId];
    const trimmed = prompt?.trim();
    if (trimmed) argv.push("--", trimmed);
    return argv;
  },

  // Codex reads AGENTS.md, discovered up the dir tree, as plain text — it has no `@path` import
  // mechanism, so servant must inline referenced content rather than link it.
  conventions: { filename: "AGENTS.md", supportsImports: false },

  prompts: {
    dir: () => codexPromptsDir(),
    // Codex prompts are flat top-level files with no `:` namespace, so the servant prefix lives in
    // the filename: `servant-goal.md` -> `/prompts:servant-goal`.
    filename: (commandId: string) => `servant-${commandId}.md`,
  },

  headless: {
    selfExclusion: "ephemeral",
    // Codex exec prints only the final agent message to stdout (progress goes to stderr), so the
    // extraction runner's "last stdout line is the summary" contract holds without `--json`.
    extractionArgv(prompt: string, opts: ExtractionArgvOptions): string[] {
      return [
        "codex",
        "exec",
        ...opts.modelArgs,
        ...HEADLESS_EXEC_FLAGS,
        "--add-dir",
        opts.addDir,
        "--",
        prompt,
      ];
    },
    // `sessionId` is unused: `--ephemeral` self-exclusion needs no pre-assigned id. The judge prompt
    // instructs the agent to write its verdict JSON to a file under `addDir` (the cache), same as Claude.
    judgeArgv(prompt: string, opts: JudgeArgvOptions): string[] {
      return [
        "codex",
        "exec",
        ...opts.modelArgs,
        ...HEADLESS_EXEC_FLAGS,
        "--add-dir",
        opts.addDir,
        "--",
        prompt,
      ];
    },
  },
};
