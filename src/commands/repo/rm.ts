import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { removeWorktree, repoCommonDir } from "../../core/git.ts";
import { resolveWorkspaceName } from "../../core/workspace.ts";
import { worktreePath } from "../../core/worktree-naming.ts";

function parseTarget(spec: string): { repo: string; branch: string } {
  const at = spec.indexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`Target must be <repo>@<branch>. Got: "${spec}"`);
  }
  return { repo: spec.slice(0, at), branch: spec.slice(at + 1) };
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
      description: "Target as <repo>@<branch>. Resolves to repos/<repo>__<branch>/.",
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

    const targetPath = worktreePath(workspace, repo, branch);
    if (!existsSync(targetPath)) {
      throw new Error(`Worktree not found at ${targetPath}`);
    }

    const common = await repoCommonDir(targetPath);
    const sourceRepo = resolve(targetPath, common, "..");
    await removeWorktree(sourceRepo, targetPath, { force: Boolean(args.force) });

    // `git worktree remove` already removes the directory, but if it left anything behind
    // (e.g. untracked files with --force), tidy up.
    if (existsSync(targetPath)) {
      await rm(targetPath, { recursive: true, force: true });
    }

    console.log(`servant: removed worktree ${targetPath}`);
  },
});
