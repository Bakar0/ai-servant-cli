export interface OpenTabOptions {
  cwd: string;
  command: string;
  title?: string;
}

export interface TerminalDriver {
  readonly name: string;
  openTab(opts: OpenTabOptions): Promise<void>;
}
