import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { listWorktrees, repoCommonDir } from "../../core/git.ts";
import { resolveWorkspaceName } from "../../core/workspace.ts";
import { parseWorktreeDirName, reposRoot } from "../../core/worktree-naming.ts";

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
    const root = reposRoot(workspace);

    if (!existsSync(root)) {
      console.log(`servant: no worktrees under ${root}`);
      return;
    }

    const entries = await readdir(root);
    type Entry = { worktreePath: string; branch?: string };
    const grouped = new Map<string, Entry[]>();

    for (const name of entries) {
      const parsed = parseWorktreeDirName(name);
      if (!parsed) continue;
      const candidate = join(root, name);
      if (!existsSync(join(candidate, ".git"))) continue;
      try {
        const common = await repoCommonDir(candidate);
        const sourceRepo = resolve(candidate, common, "..");
        const trees = await listWorktrees(sourceRepo);
        const match = trees.find((t) => t.path === candidate);
        const list = grouped.get(parsed.repoSubdir) ?? [];
        list.push({
          worktreePath: candidate,
          ...(match?.branch ? { branch: match.branch } : { branch: parsed.branch }),
        });
        grouped.set(parsed.repoSubdir, list);
      } catch {
        // ignore unreadable worktrees
      }
    }

    if (grouped.size === 0) {
      console.log(`servant: no worktrees under ${root}`);
      return;
    }

    for (const [repoDir, list] of grouped) {
      console.log(`${repoDir}:`);
      for (const e of list) {
        const tag = e.branch ? `  [${e.branch}]` : "";
        console.log(`  ${e.worktreePath}${tag}`);
      }
    }
  },
});
