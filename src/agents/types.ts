export interface CodingAgent {
  readonly name: string;
  launchCommand(cwd: string): string;
}
