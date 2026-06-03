import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  addWorktree,
  detectDefaultBranch,
  fetchBranch,
  localBranchExists,
  remoteBranchExists,
} from "../../core/git.ts";
import { workspacePath } from "../../core/paths.ts";
import { type DiscoveredRepo, discoverRepos } from "../../core/repo-discovery.ts";
import { ensureWorkspaceDir, resolveWorkspaceName } from "../../core/workspace.ts";
import { pickMultipleFromList } from "../../ui/picker.ts";
import { promptText } from "../../ui/prompts.ts";
import { ensureConfigInteractive } from "./first-run.ts";

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

function filterRepos(repos: DiscoveredRepo[], hint: string | undefined): DiscoveredRepo[] {
  if (!hint) return repos;
  const lower = hint.toLowerCase();
  return repos.filter(
    (r) => r.name.toLowerCase().includes(lower) || r.path.toLowerCase().includes(lower),
  );
}

function formatRepoMatches(repos: DiscoveredRepo[]): string {
  return repos.map((r) => `  - ${r.name}  (${r.path})`).join("\n");
}

async function selectRepos(
  repos: DiscoveredRepo[],
  hint: string | undefined,
): Promise<DiscoveredRepo[]> {
  const matches = filterRepos(repos, hint);
  if (matches.length === 0) {
    const tried = hint ? ` matching "${hint}"` : "";
    throw new Error(`No repos found${tried}. Scanned roots from ~/.ai_servant/config.json.`);
  }
  if (matches.length === 1) return [matches[0] as DiscoveredRepo];
  if (!isInteractive()) {
    throw new Error(
      `Multiple repos match — pick one with --repo <unique-hint>:\n${formatRepoMatches(matches)}`,
    );
  }

  const picked = await pickMultipleFromList(matches, {
    format: (r) => (r.collides ? `${r.name}  (${r.path})` : r.name),
    preview: (r) => [`path:   ${r.path}`, `origin: ${r.remoteUrl ?? "(none)"}`].join("\n"),
    prompt: "repo",
    header:
      "type to filter · ↑/↓ move · tab to toggle (multi) · ctrl-a toggle all · enter confirm · esc cancel",
  });
  if (!picked || picked.length === 0) throw new Error("No repo selected.");
  return picked;
}

export const repoAddCommand = defineCommand({
  meta: {
    name: "add",
    description:
      "Pick a local repo and add a git worktree under the current workspace at workspaces/<ws>/repos/<repo>/<branch>/.",
  },
  args: {
    repo: {
      type: "positional",
      required: false,
      description: "Hint to filter discovered repos (substring match on name or path).",
    },
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Workspace name. If omitted, auto-detected.",
    },
    branch: {
      type: "string",
      required: false,
      alias: "b",
      description: "Branch name for the new worktree.",
    },
    base: {
      type: "string",
      required: false,
      description: "Base ref to branch from (defaults to repo's default branch).",
    },
    track: {
      type: "boolean",
      required: false,
      default: false,
      description: "Track the same-named remote branch on origin instead of branching from base.",
    },
    as: {
      type: "string",
      required: false,
      description: "Alias for the repo subdir under workspaces/<ws>/repos/ (for collisions).",
    },
    "no-fetch": {
      type: "boolean",
      required: false,
      default: false,
      description: "Skip `git fetch origin` before resolving branches.",
    },
    refresh: {
      type: "boolean",
      required: false,
      default: false,
      description: "Force a rescan of repo search roots (ignore the discovery cache).",
    },
  },
  async run({ args }) {
    const workspace = await resolveWorkspaceName(args.workspace);
    await ensureWorkspaceDir(workspace);

    const config = await ensureConfigInteractive();
    const repos = await discoverRepos(config, { refresh: Boolean(args.refresh) });
    const selected = await selectRepos(repos, args.repo);

    if (args.as && selected.length > 1) {
      throw new Error("--as <alias> only makes sense when selecting a single repo.");
    }

    let branch = args.branch;
    if (!branch) {
      if (!isInteractive()) {
        throw new Error("Branch name required: pass --branch <name>.");
      }
      branch = (await promptText("Branch name for new worktree")).trim();
      if (!branch) throw new Error("Branch name is required.");
    }

    const skipFetch = Boolean(args["no-fetch"]);
    let track = Boolean(args.track);
    // For multi-select, we want a single track decision for all repos rather than re-prompting
    // per repo. Capture it once if needed by the first repo that has the remote branch.
    let trackDecisionMade = track || !isInteractive();

    for (const repo of selected) {
      if (repo.collides && !args.as) {
        throw new Error(
          `Repo basename "${repo.name}" collides with another discovered repo. Re-run with --as <alias> (single selection only) to disambiguate.\nSelected: ${repo.path}`,
        );
      }
      const subdir = args.as ?? repo.name;
      const base = args.base ?? (await detectDefaultBranch(repo.path));

      if (!skipFetch) {
        try {
          await fetchBranch(repo.path, base);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `servant: warning — fetch of base "${base}" in ${repo.name} failed: ${msg}\n`,
          );
        }
        if (track) {
          await fetchBranch(repo.path, branch);
        }
      }

      if (await localBranchExists(repo.path, branch)) {
        throw new Error(
          `Branch "${branch}" already exists locally in ${repo.path}. Pick a different name or check it out manually.`,
        );
      }

      if (!track && (await remoteBranchExists(repo.path, branch))) {
        if (!trackDecisionMade) {
          const wantTrack = (
            await promptText(
              `Branch "${branch}" exists on origin (${repo.name}). Track it${selected.length > 1 ? " for all selected repos" : ""}? (y/N)`,
            )
          ).toLowerCase();
          trackDecisionMade = true;
          if (wantTrack === "y" || wantTrack === "yes") {
            track = true;
            if (!skipFetch) await fetchBranch(repo.path, branch);
          } else {
            throw new Error(
              `Refusing to create local-only "${branch}" that shadows origin/${branch}.`,
            );
          }
        } else if (!track) {
          throw new Error(
            `Branch "${branch}" exists on origin in ${repo.name}. Pass --track to track it, or pick a different name.`,
          );
        }
      }

      const worktreePath = join(workspacePath(workspace), "repos", subdir, branch);
      if (existsSync(worktreePath)) {
        throw new Error(`Worktree path already exists: ${worktreePath}`);
      }

      if (track) {
        await addWorktree(repo.path, worktreePath, { branch, track: true });
      } else {
        await addWorktree(repo.path, worktreePath, { branch, base });
      }

      console.log(`servant: created worktree at ${worktreePath}`);
      console.log(`  cd ${worktreePath}`);
    }
  },
});
