import type { OpenTabOptions, TerminalDriver } from "./types.ts";

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeShellSingleQuoted(value: string): string {
  // Wrap in single quotes; close, escape the single quote, reopen.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildAppleScript(cwd: string, command: string): string {
  const shellCommand = `cd ${escapeShellSingleQuoted(cwd)} && clear && ${command}`;
  const asCommand = escapeAppleScriptString(shellCommand);
  return `
tell application "iTerm"
  activate
  if (count of windows) = 0 then
    set newWindow to (create window with default profile)
    tell current session of newWindow to write text "${asCommand}"
  else
    tell current window
      set newTab to (create tab with default profile)
      tell current session of newTab to write text "${asCommand}"
    end tell
  end if
end tell
`;
}

export const itermDriver: TerminalDriver = {
  name: "iterm",
  async openTab({ cwd, command }: OpenTabOptions): Promise<void> {
    const script = buildAppleScript(cwd, command);
    const proc = Bun.spawn(["osascript", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(script);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`iTerm AppleScript failed (exit ${exitCode}): ${stderr.trim()}`);
    }
  },
};
