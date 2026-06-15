import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

let scratch: string;
let aiServantRootDir: string;
let codeRoot: string;
let originRepo: string;
let cloneRepo: string;
const WS = "ws1";

const originalEnv = process.env.AI_SERVANT_ROOT;

async function git(repo: string, ...args: string[]) {
  const proc = await $`git -C ${repo} ${args}`.nothrow().quiet();
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-repo-test-")));
  aiServantRootDir = join(scratch, ".ai_servant");
  codeRoot = join(scratch, "code");
  await mkdir(aiServantRootDir, { recursive: true });
  await mkdir(codeRoot, { recursive: true });

  // Build an origin + clone called "alpha"
  originRepo = join(scratch, "alpha-origin.git");
  await $`git init --bare -b main ${originRepo}`.quiet();

  const seed = join(scratch, "alpha-seed");
  await $`git init -b main ${seed}`.quiet();
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  await writeFile(join(seed, "README.md"), "alpha\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "initial");
  await git(seed, "remote", "add", "origin", originRepo);
  await git(seed, "push", "-u", "origin", "main");

  cloneRepo = join(codeRoot, "alpha");
  await $`git clone ${originRepo} ${cloneRepo}`.quiet();
  await git(cloneRepo, "config", "user.email", "test@example.com");
  await git(cloneRepo, "config", "user.name", "Test");
  await git(cloneRepo, "remote", "set-head", "origin", "main");

  process.env.AI_SERVANT_ROOT = aiServantRootDir;

  // Seed config so discovery uses codeRoot
  const { saveConfig } = await import("../src/core/config.ts");
  await saveConfig({ repoSearchRoots: [codeRoot], scanMaxDepth: 4 });
});

afterAll(async () => {
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AI_SERVANT_ROOT");
  else process.env.AI_SERVANT_ROOT = originalEnv;
  await rm(scratch, { recursive: true, force: true });
});

const { repoAddCommand } = await import("../src/commands/repo/add.ts");
const { repoListCommand } = await import("../src/commands/repo/list.ts");
const { repoRmCommand } = await import("../src/commands/repo/rm.ts");
const { runCommand } = await import("citty");

describe("repo add (non-interactive)", () => {
  test("creates a worktree from the default base with an explicit branch", async () => {
    await runCommand(repoAddCommand, {
      rawArgs: ["alpha", "--workspace", WS, "--branch", "topic-new", "--no-fetch"],
    });
    const wt = join(aiServantRootDir, "workspaces", WS, "repos", "alpha__topic-new");
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, ".git"))).toBe(true);
    expect(existsSync(join(wt, "README.md"))).toBe(true);
  });

  test("refuses if branch already exists locally", async () => {
    await expect(
      runCommand(repoAddCommand, {
        rawArgs: ["alpha", "--workspace", WS, "--branch", "topic-new", "--no-fetch"],
      }),
    ).rejects.toThrow(/already exists/i);
  });

  test("refuses if no repos match the hint", async () => {
    await expect(
      runCommand(repoAddCommand, {
        rawArgs: ["zzz-no-such", "--workspace", WS, "--branch", "x", "--no-fetch"],
      }),
    ).rejects.toThrow(/No repos found/i);
  });

  test("rejects branch overrides containing '/' or the divider", async () => {
    await expect(
      runCommand(repoAddCommand, {
        rawArgs: ["alpha", "--workspace", WS, "--branch", "feature/x", "--no-fetch"],
      }),
    ).rejects.toThrow(/must not contain "\/"/);
    await expect(
      runCommand(repoAddCommand, {
        rawArgs: ["alpha", "--workspace", WS, "--branch", "foo__bar", "--no-fetch"],
      }),
    ).rejects.toThrow(/reserved as the worktree divider/);
  });

  test("auto-generates a <workspace>-<shortid> branch when --branch is omitted", async () => {
    await runCommand(repoAddCommand, {
      rawArgs: ["alpha", "--workspace", WS, "--no-fetch"],
    });
    const { readdir } = await import("node:fs/promises");
    const reposDir = join(aiServantRootDir, "workspaces", WS, "repos");
    const names = await readdir(reposDir);
    expect(names.some((n) => /^alpha__ws1-[0-9a-z]{4}$/.test(n))).toBe(true);
  });
});

describe("repo list", () => {
  test("lists the worktree we created", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map((x) => String(x)).join(" "));
    };
    try {
      await runCommand(repoListCommand, { rawArgs: ["--workspace", WS] });
    } finally {
      console.log = origLog;
    }
    const joined = lines.join("\n");
    expect(joined).toContain("alpha:");
    expect(joined).toMatch(/topic-new/);
  });
});

describe("repo rm", () => {
  test("requires <repo>@<branch> form", async () => {
    await expect(
      runCommand(repoRmCommand, { rawArgs: ["alpha", "--workspace", WS] }),
    ).rejects.toThrow(/<repo>@<branch>/);
  });

  test("removes the worktree directory", async () => {
    await runCommand(repoRmCommand, {
      rawArgs: ["alpha@topic-new", "--workspace", WS, "--force"],
    });
    const wt = join(aiServantRootDir, "workspaces", WS, "repos", "alpha__topic-new");
    expect(existsSync(wt)).toBe(false);
  });
});
