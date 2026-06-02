import { cmuxDriver } from "./cmux.ts";
import { itermDriver } from "./iterm.ts";
import type { TerminalDriver } from "./types.ts";

export type TerminalName = "cmux" | "iterm";

const DRIVERS: Record<TerminalName, TerminalDriver> = {
  cmux: cmuxDriver,
  iterm: itermDriver,
};

export function getDriver(name: string): TerminalDriver {
  if (name === "cmux" || name === "iterm") return DRIVERS[name];
  throw new Error(`Unknown terminal "${name}". Supported: cmux, iterm.`);
}

export interface DetectEnv {
  TERM_PROGRAM?: string | undefined;
  CMUX_SOCKET_PATH?: string | undefined;
  platform?: NodeJS.Platform;
  cmuxOnPath?: boolean;
}

export function detectTerminalName(env: DetectEnv): TerminalName | null {
  if (env.TERM_PROGRAM === "cmux" || env.CMUX_SOCKET_PATH) return "cmux";
  if (env.TERM_PROGRAM === "iTerm.app") return "iterm";
  if (env.platform === "darwin") {
    if (env.cmuxOnPath) return "cmux";
    return "iterm";
  }
  return null;
}

async function isCmuxOnPath(): Promise<boolean> {
  const proc = Bun.spawn(["sh", "-c", "command -v cmux"], { stdout: "pipe", stderr: "pipe" });
  return (await proc.exited) === 0;
}

export async function detectTerminal(): Promise<TerminalDriver> {
  const env: DetectEnv = {
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
    platform: process.platform,
    cmuxOnPath: await isCmuxOnPath(),
  };
  const name = detectTerminalName(env);
  if (!name) {
    throw new Error(
      "Could not auto-detect a supported terminal. Pass --terminal cmux|iterm explicitly. Supported terminals are iTerm2 and cmux (macOS only).",
    );
  }
  return getDriver(name);
}
