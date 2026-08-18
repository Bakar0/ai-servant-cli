import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";
import {
  type WorkspaceSnapshot,
  composeSummonsInstructions,
  readWorkspaceSnapshot,
  resolveSummonsScope,
} from "../src/core/summons-context.ts";

const SNAPSHOT: WorkspaceSnapshot = {
  workspace: "demo",
  scopeLabel: "the whole workspace",
  goal: "## Mission\nShip the servant CLI.",
  glossary: "## Summons\nA live spoken conversation.",
  tickets: [
    { number: 15, title: "servant summon end-to-end", url: "https://hub/15" },
    { number: 17, title: "delegate to Claude", url: "https://hub/17" },
  ],
  tree: ["GOAL.md", "docs/adr/0009-talk.md"],
};

describe("composeSummonsInstructions", () => {
  test("puts the freshly-read workspace state in front of the agent", () => {
    const instructions = composeSummonsInstructions(SNAPSHOT);

    expect(instructions).toContain("Ship the servant CLI.");
    expect(instructions).toContain("A live spoken conversation.");
    expect(instructions).toContain("#15");
    expect(instructions).toContain("servant summon end-to-end");
    expect(instructions).toContain("docs/adr/0009-talk.md");
    expect(instructions).toContain("demo");
  });

  test("says nothing about a Briefing when none was supplied", () => {
    expect(composeSummonsInstructions(SNAPSHOT)).not.toContain("Briefing");
  });

  test("a Briefing is added in front of the workspace state, not instead of it", () => {
    const instructions = composeSummonsInstructions(
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

  test("tells the agent it delegates heavy work rather than doing it", () => {
    const instructions = composeSummonsInstructions(SNAPSHOT);

    expect(instructions).toContain("delegate");
  });

  test("degrades to a usable session when the workspace is empty", () => {
    const instructions = composeSummonsInstructions({
      workspace: "fresh",
      scopeLabel: "the whole workspace",
      goal: "",
      glossary: "",
      tickets: [],
      tree: [],
    });

    expect(instructions).toContain("fresh");
    expect(instructions.trim().length).toBeGreaterThan(0);
  });
});

describe("summons scope and snapshot", () => {
  let scratch: string;
  const WS = "summonws";

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-summons-test-")));
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
    await mkdir(join(ws, "repos", "alpha__summonws-1234", ".git"), { recursive: true });
    await mkdir(join(ws, "repos", "alpha__summonws-1234", "node_modules", "junk"), {
      recursive: true,
    });
    await writeFile(join(ws, "GOAL.md"), "# Goal\n\nShip the talking servant.\n");
    await writeFile(join(ws, "CONTEXT.md"), "# Context\n\n## Summons\nA spoken conversation.\n");
    await writeFile(join(ws, "docs", "adr", "0009-talk.md"), "# ADR 9\n");
    await writeFile(join(ws, "repos", "alpha__summonws-1234", "README.md"), "alpha\n");
    await writeFile(join(ws, "repos", "alpha__summonws-1234", ".git", "HEAD"), "ref: main\n");
    await writeFile(
      join(ws, "repos", "alpha__summonws-1234", "node_modules", "junk", "index.js"),
      "1\n",
    );
    // The board, seeded as the real thing rather than faked: this workspace's open ticket, plus
    // one on another workspace's board that must not leak into the snapshot.
    const { createTicket } = await import("../src/core/board/store.ts");
    createTicket({ workspace: WS, title: "servant summon", seq: 15 });
    createTicket({ workspace: "other", title: "someone else's ticket", seq: 99 });
  });

  afterAll(async () => {
    const { closeBoard } = await import("../src/core/board/store.ts");
    closeBoard();
    setRootOverride(null);
    await rm(scratch, { recursive: true, force: true });
  });

  test("defaults to the whole workspace", async () => {
    const scope = await resolveSummonsScope(WS, undefined);

    expect(scope.root).toBe(join(scratch, "workspaces", WS));
    expect(scope.label).toContain("whole workspace");
  });

  test("--repo narrows the scope to that mounted repo", async () => {
    const scope = await resolveSummonsScope(WS, "alpha");

    expect(scope.root).toBe(join(scratch, "workspaces", WS, "repos", "alpha__summonws-1234"));
    expect(scope.label).toContain("alpha");
  });

  test("--repo naming a repo that isn't mounted lists what is", async () => {
    await expect(resolveSummonsScope(WS, "beta")).rejects.toThrow(/alpha/);
  });

  test("the snapshot carries the goal, glossary, this workspace's board and the tree", async () => {
    const scope = await resolveSummonsScope(WS, undefined);
    const snapshot = await readWorkspaceSnapshot(scope);

    expect(snapshot.goal).toContain("Ship the talking servant.");
    expect(snapshot.glossary).toContain("A spoken conversation.");
    // Only this workspace's board — another workspace's ticket #99 is on a different board.
    expect(snapshot.tickets.map((t) => t.number)).toEqual([15]);
    expect(snapshot.tickets[0]?.title).toBe("servant summon");
    expect(snapshot.tree).toContain("docs/adr/0009-talk.md");
  });

  test("closed tickets are left off the list the agent opens with", async () => {
    const { createTicket, requireTicket, updateTicket } = await import(
      "../src/core/board/store.ts"
    );
    createTicket({ workspace: WS, title: "already shipped", seq: 3 });
    updateTicket(requireTicket(WS, 3), { status: "done" });
    const scope = await resolveSummonsScope(WS, undefined);

    expect((await readWorkspaceSnapshot(scope)).tickets.map((t) => t.number)).toEqual([15]);
  });

  test("the tree skips version-control and dependency noise", async () => {
    const scope = await resolveSummonsScope(WS, "alpha");
    const snapshot = await readWorkspaceSnapshot(scope);

    expect(snapshot.tree).toContain("README.md");
    expect(snapshot.tree.some((p) => p.includes(".git/"))).toBe(false);
    expect(snapshot.tree.some((p) => p.includes("node_modules"))).toBe(false);
  });

  test("the goal is re-read on every launch, never cached from a previous one", async () => {
    const scope = await resolveSummonsScope(WS, undefined);
    const before = await readWorkspaceSnapshot(scope);
    expect(before.goal).toContain("Ship the talking servant.");

    await writeFile(join(scratch, "workspaces", WS, "GOAL.md"), "# Goal\n\nShip something else.\n");
    const after = await readWorkspaceSnapshot(scope);

    expect(after.goal).toContain("Ship something else.");
  });
});
