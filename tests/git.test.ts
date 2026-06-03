import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  addWorktree,
  detectDefaultBranch,
  listWorktrees,
  localBranchExists,
  remoteBranchExists,
  removeWorktree,
  repoCommonDir,
} from "../src/core/git.ts";

let scratch: string;
let originRepo: string;
let cloneRepo: string;

async function git(repo: string, ...args: string[]) {
  const proc = await $`git -C ${repo} ${args}`.nothrow().quiet();
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-git-test-")));

  originRepo = join(scratch, "origin.git");
  await $`git init --bare -b main ${originRepo}`.quiet();

  const seed = join(scratch, "seed");
  await $`git init -b main ${seed}`.quiet();
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  await writeFile(join(seed, "README.md"), "hello\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "initial");
  await git(seed, "remote", "add", "origin", originRepo);
  await git(seed, "push", "-u", "origin", "main");
  // create a remote-only branch for tracking tests
  await git(seed, "checkout", "-b", "feature/remote-only");
  await writeFile(join(seed, "f.txt"), "x\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "remote only");
  await git(seed, "push", "-u", "origin", "feature/remote-only");
  await git(seed, "checkout", "main");
  await git(seed, "branch", "-D", "feature/remote-only");

  cloneRepo = join(scratch, "clone");
  await $`git clone ${originRepo} ${cloneRepo}`.quiet();
  await git(cloneRepo, "config", "user.email", "test@example.com");
  await git(cloneRepo, "config", "user.name", "Test");
  // ensure origin/HEAD symref exists
  await git(cloneRepo, "remote", "set-head", "origin", "main");
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("detectDefaultBranch", () => {
  test("returns the branch from origin/HEAD symref", async () => {
    const branch = await detectDefaultBranch(cloneRepo);
    expect(branch).toBe("main");
  });
});

describe("local/remoteBranchExists", () => {
  test("main exists locally", async () => {
    expect(await localBranchExists(cloneRepo, "main")).toBe(true);
  });
  test("nonexistent branch returns false", async () => {
    expect(await localBranchExists(cloneRepo, "no-such-branch")).toBe(false);
  });
  test("feature/remote-only is on origin but not local", async () => {
    expect(await remoteBranchExists(cloneRepo, "feature/remote-only")).toBe(true);
    expect(await localBranchExists(cloneRepo, "feature/remote-only")).toBe(false);
  });
});

describe("addWorktree + listWorktrees + removeWorktree", () => {
  test("adds a worktree from base branch and lists it", async () => {
    const wt = join(scratch, "wt-from-base");
    await addWorktree(cloneRepo, wt, { branch: "topic/x", base: "main" });

    const trees = await listWorktrees(cloneRepo);
    const entry = trees.find((t) => t.path === wt);
    expect(entry).toBeTruthy();
    expect(entry?.branch).toBe("topic/x");

    await removeWorktree(cloneRepo, wt);
    const trees2 = await listWorktrees(cloneRepo);
    expect(trees2.find((t) => t.path === wt)).toBeUndefined();
  });

  test("addWorktree with track creates a tracking branch from origin/<branch>", async () => {
    const wt = join(scratch, "wt-tracking");
    await addWorktree(cloneRepo, wt, { branch: "feature/remote-only", track: true });
    expect(await localBranchExists(cloneRepo, "feature/remote-only")).toBe(true);
    await removeWorktree(cloneRepo, wt);
  });

  test("addWorktree refuses if branch already exists", async () => {
    const wt = join(scratch, "wt-dup");
    await addWorktree(cloneRepo, wt, { branch: "dup/branch", base: "main" });
    await expect(
      addWorktree(cloneRepo, join(scratch, "wt-dup2"), { branch: "dup/branch", base: "main" }),
    ).rejects.toThrow(/dup\/branch|already/i);
    await removeWorktree(cloneRepo, wt);
  });
});

describe("repoCommonDir", () => {
  test("returns the main repo's git dir from inside a worktree", async () => {
    const wt = join(scratch, "wt-common");
    await addWorktree(cloneRepo, wt, { branch: "topic/common", base: "main" });
    const common = await repoCommonDir(wt);
    // git-common-dir may be returned as a relative path; resolve via cwd
    const { resolve } = await import("node:path");
    const resolved = resolve(wt, common);
    expect(resolved).toBe(join(cloneRepo, ".git"));
    await removeWorktree(cloneRepo, wt);
  });
});
