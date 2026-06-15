import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { defineCommand } from "citty";
import {
  addWorktree,
  detectDefaultBranch,
  fetchBranch,
  localBranchExists,
  remoteBranchExists,
} from "../../core/git.ts";
import { type DiscoveredRepo, discoverRepos } from "../../core/repo-discovery.ts";
import { ensureWorkspaceDir, resolveWorkspaceName } from "../../core/workspace.ts";
import {
  generateBranchName,
  parseWorktreeDirName,
  reposRoot,
  validateBranchForDir,
  validateRepoSubdir,
  worktreePath,
} from "../../core/worktree-naming.ts";
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
      "Pick a local repo and add a git worktree under the current workspace at workspaces/<ws>/repos/<repo>__<branch>/. Branch defaults to <workspace>-<shortid>.",
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
      description:
        "Override the auto-generated branch name. Must not contain '/' or '__'. Defaults to <workspace>-<shortid>.",
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
    await addReposInteractive({
      workspace,
      repoHint: args.repo,
      branch: args.branch,
      base: args.base,
      track: Boolean(args.track),
      as: args.as,
      noFetch: Boolean(args["no-fetch"]),
      refresh: Boolean(args.refresh),
    });
  },
});

export type AddReposOptions = {
  /** Resolved workspace name. The workspace dir must already exist. */
  workspace: string;
  /** Substring hint to pre-filter discovered repos before the picker. */
  repoHint?: string | undefined;
  /** Override the auto-generated branch name. */
  branch?: string | undefined;
  /** Base ref to branch from (defaults to each repo's default branch). */
  base?: string | undefined;
  /** Track the same-named remote branch instead of branching from base. */
  track?: boolean;
  /** Alias for the repo subdir (single-selection collisions only). */
  as?: string | undefined;
  /** Skip `git fetch origin` before resolving branches. */
  noFetch?: boolean;
  /** Force a rescan of repo search roots (ignore the discovery cache). */
  refresh?: boolean;
};

/**
 * Discover repos, let the user pick one or more (interactive picker in the current
 * TTY), and add a git worktree per selection under workspaces/<ws>/repos/<repo>__<branch>/.
 *
 * Shared by `servant repo add` and `servant spawn -r`. The caller is responsible for
 * resolving the workspace name and ensuring the workspace dir exists.
 */
export async function addReposInteractive(opts: AddReposOptions): Promise<void> {
  const { workspace } = opts;

  const config = await ensureConfigInteractive();
  const repos = await discoverRepos(config, { refresh: Boolean(opts.refresh) });
  const selected = await selectRepos(repos, opts.repoHint);

  if (opts.as && selected.length > 1) {
    throw new Error("--as <alias> only makes sense when selecting a single repo.");
  }

  // Resolve target subdir for each repo up-front so we can collision-check branches across them.
  const subdirs = selected.map((r) => opts.as ?? r.name);
  for (const s of subdirs) validateRepoSubdir(s);

  let branch: string;
  if (opts.branch) {
    branch = opts.branch;
    validateBranchForDir(branch);
  } else {
    const takenBranches = await collectExistingBranches(workspace, subdirs);
    branch = generateBranchName(workspace, takenBranches);
    console.log(`servant: generated branch ${branch}`);
  }

  const skipFetch = Boolean(opts.noFetch);
  let track = Boolean(opts.track);
  // For multi-select, we want a single track decision for all repos rather than re-prompting
  // per repo. Capture it once if needed by the first repo that has the remote branch.
  let trackDecisionMade = track || !isInteractive();

  for (let i = 0; i < selected.length; i++) {
    const repo = selected[i] as DiscoveredRepo;
    if (repo.collides && !opts.as) {
      throw new Error(
        `Repo basename "${repo.name}" collides with another discovered repo. Re-run with --as <alias> (single selection only) to disambiguate.\nSelected: ${repo.path}`,
      );
    }
    const subdir = subdirs[i] as string;
    const base = opts.base ?? (await detectDefaultBranch(repo.path));

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

    const targetPath = worktreePath(workspace, subdir, branch);
    if (existsSync(targetPath)) {
      throw new Error(`Worktree path already exists: ${targetPath}`);
    }

    if (track) {
      await addWorktree(repo.path, targetPath, { branch, track: true });
    } else {
      // Branch from the remote-tracking ref (just fetched) rather than the local base,
      // which may be stale. Fall back to local base if --no-fetch was passed and there's
      // no remote-tracking ref yet.
      const baseRef =
        !skipFetch || (await remoteBranchExists(repo.path, base)) ? `origin/${base}` : base;
      await addWorktree(repo.path, targetPath, { branch, base: baseRef });
    }

    console.log(`servant: created worktree at ${targetPath}`);
    console.log(`  cd ${targetPath}`);
  }
}

async function collectExistingBranches(
  workspace: string,
  subdirs: readonly string[],
): Promise<Set<string>> {
  const root = reposRoot(workspace);
  if (!existsSync(root)) return new Set();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return new Set();
  }
  const subdirSet = new Set(subdirs);
  const taken = new Set<string>();
  for (const name of entries) {
    const parsed = parseWorktreeDirName(name);
    if (!parsed) continue;
    if (subdirSet.has(parsed.repoSubdir)) taken.add(parsed.branch);
  }
  return taken;
}
