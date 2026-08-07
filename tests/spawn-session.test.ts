import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";
import type { OpenTabOptions, TerminalDriver } from "../src/terminals/types.ts";

let scratch: string;
let aiServantRootDir: string;
let priorCodexHome: string | undefined;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-spawn-core-test-")));
  aiServantRootDir = join(scratch, ".ai_servant");
  await mkdir(aiServantRootDir, { recursive: true });
  setRootOverride(aiServantRootDir);
  // Launching the codex backend installs prompts into the user's real ~/.codex; redirect it.
  priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(scratch, ".codex");

  const { saveConfig } = await import("../src/core/config.ts");
  await saveConfig({
    version: 1,
    repoSearchRoots: [],
    scanMaxDepth: 4,
    showTips: true,
    hubRepo: "acme/hub",
  });
});

afterAll(async () => {
  setRootOverride(null);
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorCodexHome;
  await rm(scratch, { recursive: true, force: true });
});

const { launchWorkspaceSession } = await import("../src/core/spawn.ts");
const { __registerDriverForTesting } = await import("../src/terminals/index.ts");

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

describe("launchWorkspaceSession", () => {
  test("scaffolds the workspace and opens a tab running the agent there", async () => {
    const { tabs, unregister } = captureTabs();
    let result: Awaited<ReturnType<typeof launchWorkspaceSession>>;
    try {
      result = await launchWorkspaceSession({ workspace: "corews", terminal: "faketerm" });
    } finally {
      unregister();
    }

    const cwd = join(aiServantRootDir, "workspaces", "corews");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.cwd).toBe(cwd);
    expect(tabs[0]?.title).toBe("corews");
    expect(result).toEqual({
      workspace: "corews",
      cwd,
      terminal: "faketerm",
      command: tabs[0]?.command ?? "",
    });
    expect(result.command).toContain("claude");
  });

  test("an explicit agent is recorded, and a later launch inherits it", async () => {
    {
      const { unregister } = captureTabs();
      try {
        await launchWorkspaceSession({
          workspace: "agentws",
          terminal: "faketerm",
          agent: "codex",
        });
      } finally {
        unregister();
      }
    }
    const { tabs, unregister } = captureTabs();
    try {
      await launchWorkspaceSession({ workspace: "agentws", terminal: "faketerm" });
    } finally {
      unregister();
    }
    expect(tabs[0]?.command).toContain("codex");
    expect(tabs[0]?.command).not.toContain("claude");
  });

  test("a workspace with no goal yet is launched with the goal-bootstrap prompt", async () => {
    const { tabs, unregister } = captureTabs();
    try {
      await launchWorkspaceSession({ workspace: "goalcore", terminal: "faketerm" });
    } finally {
      unregister();
    }
    expect(tabs[0]?.command).toContain("/servant:goal");
  });

  test("an explicit prompt wins over the goal bootstrap; a blank one does not", async () => {
    const withTask = captureTabs();
    try {
      await launchWorkspaceSession({
        workspace: "promptcore",
        terminal: "faketerm",
        prompt: "do the task",
      });
    } finally {
      withTask.unregister();
    }
    expect(withTask.tabs[0]?.command).toContain("do the task");
    expect(withTask.tabs[0]?.command).not.toContain("/servant:goal");

    const blank = captureTabs();
    try {
      await launchWorkspaceSession({ workspace: "promptcore", terminal: "faketerm", prompt: "" });
    } finally {
      blank.unregister();
    }
    expect(blank.tabs[0]?.command).toContain("/servant:goal");
  });

  test("beforeLaunch runs against the scaffolded workspace, before the tab opens", async () => {
    const order: string[] = [];
    const tabs: OpenTabOptions[] = [];
    const unregister = __registerDriverForTesting("faketerm", {
      name: "faketerm",
      async openTab(opts) {
        order.push("openTab");
        tabs.push(opts);
      },
    });
    const seen: Array<{ workspace: string; cwd: string; scaffolded: boolean }> = [];
    try {
      await launchWorkspaceSession({
        workspace: "hookws",
        terminal: "faketerm",
        async beforeLaunch(ctx) {
          order.push("beforeLaunch");
          seen.push({ ...ctx, scaffolded: existsSync(join(ctx.cwd, "GOAL.md")) });
        },
      });
    } finally {
      unregister();
    }

    expect(order).toEqual(["beforeLaunch", "openTab"]);
    expect(seen).toEqual([
      {
        workspace: "hookws",
        cwd: join(aiServantRootDir, "workspaces", "hookws"),
        scaffolded: true,
      },
    ]);
  });
});
