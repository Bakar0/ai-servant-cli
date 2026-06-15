import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { OpenTabOptions, TerminalDriver } from "../src/terminals/types.ts";

let scratch: string;
let aiServantRootDir: string;
let codeRoot: string;
const WS = "spawnws";

const originalEnv = process.env.AI_SERVANT_ROOT;

async function git(repo: string, ...args: string[]) {
  const proc = await $`git -C ${repo} ${args}`.nothrow().quiet();
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-spawn-test-")));
  aiServantRootDir = join(scratch, ".ai_servant");
  codeRoot = join(scratch, "code");
  await mkdir(aiServantRootDir, { recursive: true });
  await mkdir(codeRoot, { recursive: true });

  const originRepo = join(scratch, "alpha-origin.git");
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

  const cloneRepo = join(codeRoot, "alpha");
  await $`git clone ${originRepo} ${cloneRepo}`.quiet();
  await git(cloneRepo, "remote", "set-head", "origin", "main");

  process.env.AI_SERVANT_ROOT = aiServantRootDir;

  const { saveConfig } = await import("../src/core/config.ts");
  await saveConfig({ repoSearchRoots: [codeRoot], scanMaxDepth: 4 });
});

afterAll(async () => {
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AI_SERVANT_ROOT");
  else process.env.AI_SERVANT_ROOT = originalEnv;
  await rm(scratch, { recursive: true, force: true });
});

const { spawnCommand } = await import("../src/commands/spawn.ts");
const { __registerDriverForTesting } = await import("../src/terminals/index.ts");
const { runCommand } = await import("citty");

describe("spawn -r", () => {
  test("adds a worktree before opening the tab", async () => {
    const tabs: OpenTabOptions[] = [];
    const fakeDriver: TerminalDriver = {
      name: "faketerm",
      async openTab(opts) {
        tabs.push(opts);
      },
    };
    const unregister = __registerDriverForTesting("faketerm", fakeDriver);
    try {
      await runCommand(spawnCommand, {
        rawArgs: ["-w", WS, "-r", "--branch", "feat-x", "--terminal", "faketerm"],
      });
    } finally {
      unregister();
    }

    // Worktree was created under the workspace.
    const wt = join(aiServantRootDir, "workspaces", WS, "repos", "alpha__feat-x");
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, "README.md"))).toBe(true);

    // The tab opened in the workspace root, once, after the worktree existed.
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.cwd).toBe(join(aiServantRootDir, "workspaces", WS));
    expect(tabs[0]?.title).toBe(WS);
  });

  test("without -r, opens the tab and adds no worktree", async () => {
    const ws = "plainws";
    const tabs: OpenTabOptions[] = [];
    const fakeDriver: TerminalDriver = {
      name: "faketerm",
      async openTab(opts) {
        tabs.push(opts);
      },
    };
    const unregister = __registerDriverForTesting("faketerm", fakeDriver);
    try {
      await runCommand(spawnCommand, {
        rawArgs: ["-w", ws, "--terminal", "faketerm"],
      });
    } finally {
      unregister();
    }

    expect(tabs).toHaveLength(1);
    expect(existsSync(join(aiServantRootDir, "workspaces", ws, "repos"))).toBe(false);
  });
});
