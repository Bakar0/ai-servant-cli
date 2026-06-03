import { existsSync } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { removeWorktree, repoCommonDir } from "../../core/git.ts";
import { workspacePath } from "../../core/paths.ts";
import { resolveWorkspaceName } from "../../core/workspace.ts";

function parseTarget(spec: string): { repo: string; branch: string } {
  const at = spec.indexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`Target must be <repo>@<branch>. Got: "${spec}"`);
  }
  return { repo: spec.slice(0, at), branch: spec.slice(at + 1) };
}

async function removeIfEmpty(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir);
  if (entries.length === 0) await rmdir(dir);
}

export const repoRmCommand = defineCommand({
  meta: {
    name: "rm",
    description: "Remove a worktree registered under the current workspace.",
  },
  args: {
    target: {
      type: "positional",
      required: true,
      description: "Target as <repo>@<branch> (branch is required).",
    },
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Workspace name. If omitted, auto-detected.",
    },
    force: {
      type: "boolean",
      required: false,
      default: false,
      description: "Force removal even with uncommitted changes.",
    },
  },
  async run({ args }) {
    const workspace = await resolveWorkspaceName(args.workspace);
    const { repo, branch } = parseTarget(args.target);

    const repoSubdir = join(workspacePath(workspace), "repos", repo);
    const worktreePath = join(repoSubdir, branch);
    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree not found at ${worktreePath}`);
    }

    const common = await repoCommonDir(worktreePath);
    const sourceRepo = resolve(worktreePath, common, "..");
    await removeWorktree(sourceRepo, worktreePath, { force: Boolean(args.force) });

    // Walk back up and remove empty parents inside repos/<repo>/.
    let dir = worktreePath;
    while (dir.startsWith(repoSubdir) && dir !== repoSubdir) {
      await removeIfEmpty(dir);
      dir = resolve(dir, "..");
    }
    await removeIfEmpty(repoSubdir);

    console.log(`servant: removed worktree ${worktreePath}`);
  },
});
