import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { workspacePath, workspacesRoot } from "./paths.ts";

// Imports the servant-root CLAUDE.md so Claude Code picks up workspace conventions
// without needing parent-dir traversal to reach `~/.ai_servant/CLAUDE.md`.
const WORKSPACE_CLAUDE_MD = "@../../CLAUDE.md\n";

// Scaffold files seeded once when a workspace is created. Only written if missing
// so user edits are never clobbered. Layout matches `~/.ai_servant/CLAUDE.md`.
const SCAFFOLD_FILES: ReadonlyArray<readonly [string, string]> = [
  ["CONTEXT.md", "# Context\n\nShared language / domain glossary for this workspace.\n"],
  ["briefs/INDEX.md", "# Briefs\n"],
  ["plans/INDEX.md", "# Plans\n"],
  ["context/INDEX.md", "# Context\n"],
];

async function writeIfMissing(path: string, body: string): Promise<void> {
  try {
    await readFile(path);
    return;
  } catch {
    // missing, will write
  }
  await writeFile(path, body);
}

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
  const claudeMdPath = join(dir, "CLAUDE.md");
  let existing: string | null = null;
  try {
    existing = await readFile(claudeMdPath, "utf8");
  } catch {
    // missing, will write
  }
  if (existing !== WORKSPACE_CLAUDE_MD) {
    await writeFile(claudeMdPath, WORKSPACE_CLAUDE_MD);
  }
  for (const [rel, body] of SCAFFOLD_FILES) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeIfMissing(full, body);
  }
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

export async function resolveWorkspaceName(provided: string | undefined): Promise<string>;
export async function resolveWorkspaceName(
  provided: string | undefined,
  opts: { allowUnresolved: true },
): Promise<string | null>;
export async function resolveWorkspaceName(
  provided: string | undefined,
  opts?: { allowUnresolved?: boolean },
): Promise<string | null> {
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

  if (opts?.allowUnresolved) return null;

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
