import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { setRootOverride } from "../src/core/paths.ts";
import type { OpenTabOptions, TerminalDriver } from "../src/terminals/types.ts";

let scratch: string;
let aiServantRootDir: string;
let codeRoot: string;
const WS = "spawnws";

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

  setRootOverride(aiServantRootDir);

  const { saveConfig } = await import("../src/core/config.ts");
  await saveConfig({ version: 1, repoSearchRoots: [codeRoot], scanMaxDepth: 4, showTips: true });
});

afterAll(async () => {
  setRootOverride(null);
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

describe("spawn goal bootstrap", () => {
  function captureTabs() {
    const tabs: OpenTabOptions[] = [];
    const fakeDriver: TerminalDriver = {
      name: "faketerm",
      async openTab(opts) {
        tabs.push(opts);
      },
    };
    return { tabs, unregister: __registerDriverForTesting("faketerm", fakeDriver) };
  }

  test("a brand-new workspace launches the agent with the /goal bootstrap prompt", async () => {
    const ws = "goalboot";
    const { tabs, unregister } = captureTabs();
    try {
      await runCommand(spawnCommand, { rawArgs: ["-w", ws, "--terminal", "faketerm"] });
    } finally {
      unregister();
    }
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.command).toContain("/servant:goal");
  });

  test("a blank --prompt does not suppress the goal bootstrap", async () => {
    const ws = "goalboot-blank";
    const { tabs, unregister } = captureTabs();
    try {
      await runCommand(spawnCommand, {
        rawArgs: ["-w", ws, "--terminal", "faketerm", "-p", ""],
      });
    } finally {
      unregister();
    }
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.command).toContain("/servant:goal");
  });

  test("`-repo` (clustered short flags) still triggers the goal bootstrap", async () => {
    const ws = "goalboot-repo";
    const { tabs, unregister } = captureTabs();
    try {
      // `-repo` parses as `-r -e -p -o`: repo picker runs and `-p` is "" — the agent
      // should still be asked to define the goal, not launched with an empty prompt.
      await runCommand(spawnCommand, { rawArgs: ["-w", ws, "-repo", "--terminal", "faketerm"] });
    } finally {
      unregister();
    }
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.command).toContain("/servant:goal");
  });

  test("an explicit --prompt wins over the goal bootstrap", async () => {
    const ws = "goalboot-prompt";
    const { tabs, unregister } = captureTabs();
    try {
      await runCommand(spawnCommand, {
        rawArgs: ["-w", ws, "--terminal", "faketerm", "-p", "do the task"],
      });
    } finally {
      unregister();
    }
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.command).toContain("do the task");
    expect(tabs[0]?.command).not.toContain("/servant:goal");
  });

  test("re-spawning while the goal is still unfilled keeps offering /goal", async () => {
    const ws = "goalboot-unfilled";
    // First spawn creates the workspace (gets the bootstrap prompt).
    {
      const { unregister } = captureTabs();
      try {
        await runCommand(spawnCommand, { rawArgs: ["-w", ws, "--terminal", "faketerm"] });
      } finally {
        unregister();
      }
    }
    // The user never defined the goal, so GOAL.md still has the marker — spawn again,
    // and the agent is still asked to run /goal.
    const { tabs, unregister } = captureTabs();
    try {
      await runCommand(spawnCommand, { rawArgs: ["-w", ws, "--terminal", "faketerm"] });
    } finally {
      unregister();
    }
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.command).toContain("/servant:goal");
  });

  test("once the goal is defined, spawning no longer triggers /goal", async () => {
    const ws = "goalboot-defined";
    {
      const { unregister } = captureTabs();
      try {
        await runCommand(spawnCommand, { rawArgs: ["-w", ws, "--terminal", "faketerm"] });
      } finally {
        unregister();
      }
    }
    // Simulate the user having defined the goal: GOAL.md no longer carries the marker.
    await writeFile(
      join(aiServantRootDir, "workspaces", ws, "GOAL.md"),
      "# Goal\n\n## Mission\nShip the thing.\n",
    );
    const { tabs, unregister } = captureTabs();
    try {
      await runCommand(spawnCommand, { rawArgs: ["-w", ws, "--terminal", "faketerm"] });
    } finally {
      unregister();
    }
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.command).not.toContain("/servant:goal");
  });
});
