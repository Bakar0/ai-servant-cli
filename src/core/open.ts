// Open a file/URL in the OS default handler (the browser, for an .html file). Best-effort and
// non-blocking: the spawn is detached and never throws into a caller — a failed open must not break
// a command whose real output is the written file + its printed path.

/** The platform command that opens `target` in its default handler. */
function openArgv(target: string): string[] {
  if (process.platform === "darwin") return ["open", target];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", target];
  return ["xdg-open", target];
}

/** Fire-and-forget open of a local file or URL in the default application. */
export function openInDefaultApp(target: string): void {
  try {
    const proc = Bun.spawn(openArgv(target), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
  } catch {
    // best-effort: the path is printed regardless, so the user can open it by hand.
  }
}
