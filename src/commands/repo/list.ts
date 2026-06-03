import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { listWorktrees, repoCommonDir } from "../../core/git.ts";
import { workspacePath } from "../../core/paths.ts";
import { resolveWorkspaceName } from "../../core/workspace.ts";

async function safeReaddir(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return await readdir(dir);
}

export const repoListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List worktrees registered under the current workspace.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Workspace name. If omitted, auto-detected.",
    },
  },
  async run({ args }) {
    const workspace = await resolveWorkspaceName(args.workspace);
    const reposRoot = join(workspacePath(workspace), "repos");

    const repoDirs = await safeReaddir(reposRoot);
    if (repoDirs.length === 0) {
      console.log(`servant: no worktrees under ${reposRoot}`);
      return;
    }

    type Entry = { repoDir: string; worktreePath: string; branch?: string };
    const grouped = new Map<string, Entry[]>();

    for (const repoDir of repoDirs) {
      const repoSubdir = join(reposRoot, repoDir);
      const branches = await safeReaddir(repoSubdir);
      for (const branchSeg1 of branches) {
        const branchDir = join(repoSubdir, branchSeg1);
        // worktree path is the deepest dir that is a real git worktree; with branches like
        // "feature/x" the path is two levels deep, so walk one extra level.
        const candidates = [branchDir];
        const nested = await safeReaddir(branchDir);
        for (const sub of nested) {
          candidates.push(join(branchDir, sub));
        }

        for (const candidate of candidates) {
          if (!existsSync(join(candidate, ".git"))) continue;
          try {
            const common = await repoCommonDir(candidate);
            const sourceRepo = resolve(candidate, common, "..");
            const trees = await listWorktrees(sourceRepo);
            const match = trees.find((t) => t.path === candidate);
            const list = grouped.get(repoDir) ?? [];
            list.push({
              repoDir,
              worktreePath: candidate,
              ...(match?.branch ? { branch: match.branch } : {}),
            });
            grouped.set(repoDir, list);
          } catch {
            // ignore unreadable worktrees
          }
        }
      }
    }

    if (grouped.size === 0) {
      console.log(`servant: no worktrees under ${reposRoot}`);
      return;
    }

    for (const [repoDir, entries] of grouped) {
      console.log(`${repoDir}:`);
      for (const e of entries) {
        const tag = e.branch ? `  [${e.branch}]` : "";
        console.log(`  ${e.worktreePath}${tag}`);
      }
    }
  },
});
