import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";
import {
  type WorkspaceSnapshot,
  composeTalkInstructions,
  readWorkspaceSnapshot,
  resolveTalkScope,
} from "../src/core/talk-context.ts";

const SNAPSHOT: WorkspaceSnapshot = {
  workspace: "demo",
  scopeLabel: "the whole workspace",
  goal: "## Mission\nShip the servant CLI.",
  glossary: "## Talk session\nA live spoken conversation.",
  tickets: [
    { number: 15, title: "servant talk end-to-end", url: "https://hub/15" },
    { number: 17, title: "delegate to Claude", url: "https://hub/17" },
  ],
  tree: ["GOAL.md", "docs/adr/0009-talk.md"],
  ticketsFromCache: false,
};

describe("composeTalkInstructions", () => {
  test("puts the freshly-read workspace state in front of the agent", () => {
    const instructions = composeTalkInstructions(SNAPSHOT);

    expect(instructions).toContain("Ship the servant CLI.");
    expect(instructions).toContain("A live spoken conversation.");
    expect(instructions).toContain("#15");
    expect(instructions).toContain("servant talk end-to-end");
    expect(instructions).toContain("docs/adr/0009-talk.md");
    expect(instructions).toContain("demo");
  });

  test("says nothing about a Briefing when none was supplied", () => {
    expect(composeTalkInstructions(SNAPSHOT)).not.toContain("Briefing");
  });

  test("a Briefing is added in front of the workspace state, not instead of it", () => {
    const instructions = composeTalkInstructions(
      SNAPSHOT,
      "We were mid-way through the audio port.",
    );

    expect(instructions).toContain("We were mid-way through the audio port.");
    // Still carries everything a Briefing-less session would have.
    expect(instructions).toContain("Ship the servant CLI.");
    expect(instructions).toContain("#15");
    expect(instructions).toContain("docs/adr/0009-talk.md");
    // ...and comes first, so the agent opens where the last session left off.
    expect(instructions.indexOf("mid-way through the audio port")).toBeLessThan(
      instructions.indexOf("Ship the servant CLI."),
    );
  });

  test("says so when the ticket list could not be refreshed, rather than passing it off as current", () => {
    const stale = composeTalkInstructions({ ...SNAPSHOT, ticketsFromCache: true });

    expect(stale).toMatch(/could not|stale|out of date/i);
    expect(composeTalkInstructions(SNAPSHOT)).not.toMatch(/could not|stale|out of date/i);
  });

  test("tells the agent it delegates heavy work rather than doing it", () => {
    const instructions = composeTalkInstructions(SNAPSHOT);

    expect(instructions).toContain("delegate");
  });

  test("degrades to a usable session when the workspace is empty", () => {
    const instructions = composeTalkInstructions({
      workspace: "fresh",
      scopeLabel: "the whole workspace",
      goal: "",
      glossary: "",
      tickets: [],
      tree: [],
      ticketsFromCache: false,
    });

    expect(instructions).toContain("fresh");
    expect(instructions.trim().length).toBeGreaterThan(0);
  });
});

describe("talk scope and snapshot", () => {
  let scratch: string;
  const WS = "talkws";

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-talk-test-")));
    setRootOverride(scratch);
    const { saveConfig } = await import("../src/core/config.ts");
    await saveConfig({
      version: 1,
      repoSearchRoots: [scratch],
      scanMaxDepth: 4,
      showTips: true,
      hubRepo: "acme/hub",
    });
    const ws = join(scratch, "workspaces", WS);
    await mkdir(join(ws, "docs", "adr"), { recursive: true });
    await mkdir(join(ws, "repos", "alpha__talkws-1234", ".git"), { recursive: true });
    await mkdir(join(ws, "repos", "alpha__talkws-1234", "node_modules", "junk"), {
      recursive: true,
    });
    await writeFile(join(ws, "GOAL.md"), "# Goal\n\nShip the talking servant.\n");
    await writeFile(
      join(ws, "CONTEXT.md"),
      "# Context\n\n## Talk session\nA spoken conversation.\n",
    );
    await writeFile(join(ws, "docs", "adr", "0009-talk.md"), "# ADR 9\n");
    await writeFile(join(ws, "repos", "alpha__talkws-1234", "README.md"), "alpha\n");
    await writeFile(join(ws, "repos", "alpha__talkws-1234", ".git", "HEAD"), "ref: main\n");
    await writeFile(
      join(ws, "repos", "alpha__talkws-1234", "node_modules", "junk", "index.js"),
      "1\n",
    );
  });

  afterAll(async () => {
    setRootOverride(null);
    await rm(scratch, { recursive: true, force: true });
  });

  const HUB_ISSUES = JSON.stringify([
    {
      number: 15,
      title: "servant talk",
      state: "OPEN",
      url: "https://hub/15",
      labels: [{ name: `ws:${WS}` }],
      body: "",
    },
    {
      number: 99,
      title: "someone else's ticket",
      state: "OPEN",
      url: "https://hub/99",
      labels: [{ name: "ws:other" }],
      body: "",
    },
  ]);

  test("defaults to the whole workspace", async () => {
    const scope = await resolveTalkScope(WS, undefined);

    expect(scope.root).toBe(join(scratch, "workspaces", WS));
    expect(scope.label).toContain("whole workspace");
  });

  test("--repo narrows the scope to that mounted repo", async () => {
    const scope = await resolveTalkScope(WS, "alpha");

    expect(scope.root).toBe(join(scratch, "workspaces", WS, "repos", "alpha__talkws-1234"));
    expect(scope.label).toContain("alpha");
  });

  test("--repo naming a repo that isn't mounted lists what is", async () => {
    await expect(resolveTalkScope(WS, "beta")).rejects.toThrow(/alpha/);
  });

  test("the snapshot carries the goal, glossary, this workspace's tickets and the tree", async () => {
    const scope = await resolveTalkScope(WS, undefined);
    const snapshot = await readWorkspaceSnapshot(scope, { ghRunner: async () => HUB_ISSUES });

    expect(snapshot.goal).toContain("Ship the talking servant.");
    expect(snapshot.glossary).toContain("A spoken conversation.");
    expect(snapshot.tickets.map((t) => t.number)).toEqual([15]);
    expect(snapshot.tree).toContain("docs/adr/0009-talk.md");
    expect(snapshot.ticketsFromCache).toBe(false);
  });

  test("an unreachable hub is reported, not silently served from cache as if current", async () => {
    const scope = await resolveTalkScope(WS, undefined);
    // Prime the cache from a good fetch, then fail — fetchHubTasks falls back to the snapshot.
    await readWorkspaceSnapshot(scope, { ghRunner: async () => HUB_ISSUES });
    const offline = await readWorkspaceSnapshot(scope, {
      ghRunner: async () => {
        throw new Error("gh: network unreachable");
      },
    });

    expect(offline.tickets.map((t) => t.number)).toEqual([15]);
    expect(offline.ticketsFromCache).toBe(true);
  });

  test("the tree skips version-control and dependency noise", async () => {
    const scope = await resolveTalkScope(WS, "alpha");
    const snapshot = await readWorkspaceSnapshot(scope, { ghRunner: async () => HUB_ISSUES });

    expect(snapshot.tree).toContain("README.md");
    expect(snapshot.tree.some((p) => p.includes(".git/"))).toBe(false);
    expect(snapshot.tree.some((p) => p.includes("node_modules"))).toBe(false);
  });

  test("the goal is re-read on every launch, never cached from a previous one", async () => {
    const scope = await resolveTalkScope(WS, undefined);
    const before = await readWorkspaceSnapshot(scope, { ghRunner: async () => HUB_ISSUES });
    expect(before.goal).toContain("Ship the talking servant.");

    await writeFile(join(scratch, "workspaces", WS, "GOAL.md"), "# Goal\n\nShip something else.\n");
    const after = await readWorkspaceSnapshot(scope, { ghRunner: async () => HUB_ISSUES });

    expect(after.goal).toContain("Ship something else.");
  });
});
