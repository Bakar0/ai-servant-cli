import { $ } from "bun";

export type Worktree = {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: boolean;
  prunable?: boolean;
};

export type AddWorktreeOpts = {
  branch: string;
  base?: string;
  track?: boolean;
};

function gitError(action: string, stderr: string, stdout: string): Error {
  const msg = stderr.trim() || stdout.trim() || "(no output)";
  return new Error(`git ${action} failed: ${msg}`);
}

async function run(
  action: string,
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const proc = await $`git -C ${repoPath} ${args}`.nothrow().quiet();
  if (proc.exitCode !== 0) {
    throw gitError(action, proc.stderr.toString(), proc.stdout.toString());
  }
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const symref = await $`git -C ${repoPath} symbolic-ref --short refs/remotes/origin/HEAD`
    .nothrow()
    .quiet();
  if (symref.exitCode === 0) {
    const ref = symref.stdout.toString().trim();
    const slash = ref.indexOf("/");
    return slash >= 0 ? ref.slice(slash + 1) : ref;
  }

  const ls = await $`git -C ${repoPath} ls-remote --symref origin HEAD`.nothrow().quiet();
  if (ls.exitCode === 0) {
    const out = ls.stdout.toString();
    const match = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (match?.[1]) return match[1];
  }

  throw new Error(
    `Could not detect default branch for ${repoPath}: no origin/HEAD symref and ls-remote did not return a HEAD ref.`,
  );
}

export async function fetchBranch(repoPath: string, branch: string): Promise<void> {
  await run("fetch", repoPath, ["fetch", "origin", branch]);
}

export async function localBranchExists(repoPath: string, name: string): Promise<boolean> {
  const proc = await $`git -C ${repoPath} show-ref --verify --quiet ${`refs/heads/${name}`}`
    .nothrow()
    .quiet();
  return proc.exitCode === 0;
}

export async function remoteBranchExists(repoPath: string, name: string): Promise<boolean> {
  const proc =
    await $`git -C ${repoPath} show-ref --verify --quiet ${`refs/remotes/origin/${name}`}`
      .nothrow()
      .quiet();
  return proc.exitCode === 0;
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  opts: AddWorktreeOpts,
): Promise<void> {
  if (opts.track) {
    await run("worktree add", repoPath, [
      "worktree",
      "add",
      "--track",
      "-b",
      opts.branch,
      worktreePath,
      `origin/${opts.branch}`,
    ]);
    return;
  }
  if (!opts.base) {
    throw new Error("addWorktree: 'base' is required when 'track' is false.");
  }
  await run("worktree add", repoPath, [
    "worktree",
    "add",
    "-b",
    opts.branch,
    worktreePath,
    opts.base,
  ]);
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const { stdout } = await run("worktree list", repoPath, ["worktree", "list", "--porcelain"]);
  const out: Worktree[] = [];
  let current: Partial<Worktree> | null = null;
  const flush = () => {
    if (current?.path) out.push(current as Worktree);
    current = null;
  };
  for (const line of stdout.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
    } else if (!current) {
      // skip lines before the first "worktree" header
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  flush();
  return out;
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const args = ["worktree", "remove"];
  if (opts.force) args.push("--force");
  args.push(worktreePath);
  await run("worktree remove", repoPath, args);
}

export async function repoCommonDir(repoPath: string): Promise<string> {
  const { stdout } = await run("rev-parse", repoPath, ["rev-parse", "--git-common-dir"]);
  return stdout.trim();
}
