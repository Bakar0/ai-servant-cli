import type { OpenTabOptions, TerminalDriver } from "./types.ts";

interface CmuxWorkspace {
  ref: string;
  title: string;
}

interface CmuxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCmux(
  args: string[],
  options: { stripCallerContext?: boolean } = {},
): Promise<CmuxResult> {
  const env: Record<string, string | undefined> = { ...process.env, CMUX_QUIET: "1" };
  if (options.stripCallerContext) {
    // cmux's `send` validates that the target surface is in the same workspace as the caller's
    // CMUX_WORKSPACE_ID. When servant runs inside cmux, that env var points to *our* shell's
    // workspace, not the target one — cross-workspace sends then fail with "Surface is not a
    // terminal". Strip the caller-context vars so cmux trusts the explicit --surface flag.
    env.CMUX_WORKSPACE_ID = undefined;
    env.CMUX_SURFACE_ID = undefined;
    env.CMUX_TAB_ID = undefined;
    env.CMUX_PANEL_ID = undefined;
  }
  const proc = Bun.spawn(["cmux", ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function assertOk(result: CmuxResult, what: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `cmux ${what} failed (exit ${result.exitCode}): ${result.stderr.trim() || "no stderr"}`,
    );
  }
}

async function findWorkspaceByTitle(title: string): Promise<CmuxWorkspace | null> {
  const result = await runCmux(["workspace", "list", "--json"]);
  assertOk(result, "workspace list");
  const parsed = JSON.parse(result.stdout) as {
    workspaces?: Array<{ ref: string; title: string }>;
  };
  const found = parsed.workspaces?.find((w) => w.title === title);
  return found ? { ref: found.ref, title: found.title } : null;
}

function extractSurfaceRef(output: string): string {
  const match = output.match(/surface:\d+/);
  if (!match) {
    throw new Error(`Could not parse surface ref from cmux new-surface output: ${output.trim()}`);
  }
  return match[0];
}

async function createWorkspace(name: string, cwd: string, command: string): Promise<void> {
  const result = await runCmux([
    "new-workspace",
    "--name",
    name,
    "--cwd",
    cwd,
    "--command",
    command,
    "--focus",
    "true",
  ]);
  assertOk(result, "new-workspace");
}

async function addSurfaceToWorkspace(workspaceRef: string, command: string): Promise<void> {
  const surfaceResult = await runCmux([
    "new-surface",
    "--workspace",
    workspaceRef,
    "--type",
    "terminal",
    "--focus",
    "true",
  ]);
  assertOk(surfaceResult, "new-surface");
  const surfaceRef = extractSurfaceRef(surfaceResult.stdout);
  const sendResult = await runCmux(["send", "--surface", surfaceRef, `${command}\n`], {
    stripCallerContext: true,
  });
  assertOk(sendResult, "send");
}

export const cmuxDriver: TerminalDriver = {
  name: "cmux",
  async openTab({ cwd, command, title }: OpenTabOptions): Promise<void> {
    const workspaceName = title ?? cwd;
    const existing = await findWorkspaceByTitle(workspaceName);
    if (existing) {
      await addSurfaceToWorkspace(existing.ref, command);
    } else {
      await createWorkspace(workspaceName, cwd, command);
    }
  },
};

export const __testing = { extractSurfaceRef };
