export interface LaunchOptions {
  /**
   * Initial prompt to deliver to the agent as its first user message.
   * The agent layer is responsible for safely embedding it in the shell command.
   */
  prompt?: string;
  /**
   * Extra directories to bring into the agent's tool scope (`--add-dir`), beyond its cwd.
   * Used by the interactive analyst session to reach transcripts under `~/.claude/projects`
   * without a permission prompt per drill. Interactive launches only — never the headless
   * `claude -p` runners.
   */
  addDirs?: readonly string[];
}

export interface CodingAgent {
  readonly name: string;
  launchCommand(cwd: string, opts?: LaunchOptions): string;
}
