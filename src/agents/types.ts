export interface LaunchOptions {
  /**
   * Initial prompt to deliver to the agent as its first user message.
   * The agent layer is responsible for safely embedding it in the shell command.
   */
  prompt?: string;
}

export interface CodingAgent {
  readonly name: string;
  launchCommand(cwd: string, opts?: LaunchOptions): string;
}
