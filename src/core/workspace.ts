import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { workspacePath, workspacesRoot } from "./paths.ts";

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function assertValidWorkspaceName(name: string): void {
  if (!name) throw new Error("Workspace name is required.");
  if (name === "." || name === "..") {
    throw new Error(`Invalid workspace name: "${name}".`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`Workspace name must not contain path separators: "${name}".`);
  }
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid workspace name "${name}". Allowed: letters, digits, "_", ".", "-"; must not start with "." or "-".`,
    );
  }
}

export async function ensureWorkspaceDir(name: string): Promise<string> {
  assertValidWorkspaceName(name);
  const dir = workspacePath(name);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function detectWorkspaceNameFromCwd(cwd: string, root: string): string | null {
  const rel = relative(resolve(root), resolve(cwd));
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  const first = rel.split(sep)[0];
  if (!first) return null;
  try {
    assertValidWorkspaceName(first);
  } catch {
    return null;
  }
  return first;
}

export async function resolveWorkspaceName(provided: string | undefined): Promise<string> {
  if (provided) {
    assertValidWorkspaceName(provided);
    return provided;
  }

  const root = workspacesRoot();
  const fromCwd = detectWorkspaceNameFromCwd(process.cwd(), root);
  if (fromCwd) return fromCwd;

  const { getCurrentCmuxWorkspaceTitle } = await import("../terminals/cmux.ts");
  const inCmux = Boolean(process.env.CMUX_WORKSPACE_ID);
  let cmuxTitle: string | null = null;
  if (inCmux) {
    cmuxTitle = await getCurrentCmuxWorkspaceTitle();
    if (cmuxTitle) {
      try {
        assertValidWorkspaceName(cmuxTitle);
        if (existsSync(workspacePath(cmuxTitle))) return cmuxTitle;
      } catch {
        // fall through to error
      }
    }
  }

  const tried = [`cwd ${process.cwd()} is not under ${root}/<name>`];
  if (!inCmux) {
    tried.push("cmux workspace identity: not running inside cmux");
  } else if (cmuxTitle === null) {
    tried.push("cmux workspace identity: could not resolve current cmux workspace");
  } else {
    tried.push(`cmux workspace "${cmuxTitle}": no matching folder at ${workspacePath(cmuxTitle)}`);
  }
  throw new Error(
    `Could not auto-detect workspace. Tried:\n  - ${tried.join("\n  - ")}\nPass --workspace <name> explicitly.`,
  );
}
