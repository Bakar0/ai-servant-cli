import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-ws-test-"));
  setRootOverride(tmpRoot);
});

afterAll(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const {
  assertValidWorkspaceName,
  detectWorkspaceNameFromCwd,
  ensureWorkspaceDir,
  isGoalUnfilled,
  mountedRepoSubdirs,
  syncWorkspaceClaudeMd,
} = await import("../src/core/workspace.ts");
const { workspacePath, workspacesRoot, knowledgeProjectIndexPath } = await import(
  "../src/core/paths.ts"
);
const { mkdir } = await import("node:fs/promises");

describe("assertValidWorkspaceName", () => {
  test("accepts simple alphanumeric names", () => {
    expect(() => assertValidWorkspaceName("task_abc")).not.toThrow();
    expect(() => assertValidWorkspaceName("My-Workspace.2")).not.toThrow();
    expect(() => assertValidWorkspaceName("a")).not.toThrow();
  });

  test("rejects empty, dot, and dot-dot", () => {
    expect(() => assertValidWorkspaceName("")).toThrow();
    expect(() => assertValidWorkspaceName(".")).toThrow();
    expect(() => assertValidWorkspaceName("..")).toThrow();
  });

  test("rejects path separators", () => {
    expect(() => assertValidWorkspaceName("foo/bar")).toThrow(/path separators/);
    expect(() => assertValidWorkspaceName("../evil")).toThrow();
    expect(() => assertValidWorkspaceName("a\\b")).toThrow(/path separators/);
  });

  test("rejects names starting with dot or dash", () => {
    expect(() => assertValidWorkspaceName(".hidden")).toThrow();
    expect(() => assertValidWorkspaceName("-flag")).toThrow();
  });

  test("rejects names with disallowed characters", () => {
    expect(() => assertValidWorkspaceName("name with space")).toThrow();
    expect(() => assertValidWorkspaceName("name$")).toThrow();
  });
});

describe("ensureWorkspaceDir", () => {
  const testName = `test-${process.pid}-${Date.now()}`;

  test("creates the workspace directory under workspaces root and is idempotent", async () => {
    const dir1 = await ensureWorkspaceDir(testName);
    expect(dir1).toBe(workspacePath(testName));
    expect(dir1.startsWith(workspacesRoot())).toBe(true);
    const s = await stat(dir1);
    expect(s.isDirectory()).toBe(true);

    const dir2 = await ensureWorkspaceDir(testName);
    expect(dir2).toBe(dir1);
  });

  test("rejects invalid names before touching the filesystem", async () => {
    await expect(ensureWorkspaceDir("../evil")).rejects.toThrow();
  });

  // The workspace CLAUDE.md imports the conventions doc + GOAL.md, then INLINES the
  // knowledge index (no @-import of the external knowledge store, which would trigger
  // Claude Code's external-import trust prompt on every spawn).
  const expectBaseClaudeMd = (body: string) => {
    expect(body.startsWith("@../../CLAUDE.md\n@GOAL.md\n")).toBe(true);
    expect(body).toContain("# Servant knowledge");
    expect(body).toContain("servant recall");
    expect(body).not.toContain("@../../knowledge"); // never @-import the external store
  };

  test("writes a CLAUDE.md that imports conventions + GOAL.md and inlines the knowledge index", async () => {
    const name = `claude-md-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    expectBaseClaudeMd(await readFile(join(dir, "CLAUDE.md"), "utf8"));
  });

  test("upgrades an old single-import CLAUDE.md pointer", async () => {
    const name = `claude-md-upgrade-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "@../../CLAUDE.md\n");
    await ensureWorkspaceDir(name);
    expectBaseClaudeMd(await readFile(path, "utf8"));
  });

  test("restores the CLAUDE.md pointer if it has been tampered with", async () => {
    const name = `claude-md-restore-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "tampered");
    await ensureWorkspaceDir(name);
    expectBaseClaudeMd(await readFile(path, "utf8"));
  });

  test("scaffolds a per-workspace .claude/settings.json with the SessionEnd extraction hook only", async () => {
    const name = `settings-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
    // SessionEnd carries the knowledge-extraction enqueue — and nothing else.
    const sessionEnd = settings.hooks?.SessionEnd?.[0]?.hooks ?? [];
    expect(sessionEnd.map((h: { command: string }) => h.command)).toEqual([
      "servant extract-memories --from-hook",
    ]);
    // The deprecated telemetry recorder is no longer wired into any event (ADR-002).
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "Stop",
    ]) {
      expect(settings.hooks?.[event]).toBeUndefined();
    }
    const allCommands = JSON.stringify(settings.hooks);
    expect(allCommands).not.toContain("servant record");
  });

  test("merges the hooks into existing workspace settings without clobbering other keys", async () => {
    const name = `settings-merge-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const path = join(dir, ".claude", "settings.json");
    // Notification is not a servant-managed event, so a user hook on it must survive re-scaffold.
    await writeFile(path, JSON.stringify({ model: "opus", hooks: { Notification: [] } }));
    await ensureWorkspaceDir(name); // re-scaffold
    const settings = JSON.parse(await readFile(path, "utf8"));
    expect(settings.model).toBe("opus"); // preserved
    expect(settings.hooks.Notification).toEqual([]); // preserved (unmanaged event)
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe(
      "servant extract-memories --from-hook",
    );
    expect(settings.hooks.PostToolUse).toBeUndefined(); // recorder no longer added
  });

  test("heals a pre-ADR-002 settings.json by stripping the servant record hooks", async () => {
    const name = `settings-heal-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const path = join(dir, ".claude", "settings.json");
    // Simulate the old shape: recorder on the hot-path events + alongside extraction on SessionEnd,
    // plus an unrelated user hook that must be preserved.
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "servant record", timeout: 10 }] }],
          PostToolUse: [
            { hooks: [{ type: "command", command: "my-own-hook" }] },
            { hooks: [{ type: "command", command: "servant record", timeout: 10 }] },
          ],
          SessionEnd: [
            {
              hooks: [
                { type: "command", command: "servant extract-memories --from-hook", timeout: 15 },
                { type: "command", command: "servant record", timeout: 10 },
              ],
            },
          ],
        },
      }),
    );
    await ensureWorkspaceDir(name); // re-scaffold heals it
    const settings = JSON.parse(await readFile(path, "utf8"));
    expect(JSON.stringify(settings.hooks)).not.toContain("servant record");
    // hot-path event left empty → key removed entirely
    expect(settings.hooks.PreToolUse).toBeUndefined();
    // unrelated user hook preserved (the record-only group was dropped)
    expect(settings.hooks.PostToolUse).toEqual([
      { hooks: [{ type: "command", command: "my-own-hook" }] },
    ]);
    // extraction hook preserved on SessionEnd
    expect(settings.hooks.SessionEnd[0].hooks.map((h: { command: string }) => h.command)).toEqual([
      "servant extract-memories --from-hook",
    ]);
  });

  test("inlines a per-repo knowledge section for each mounted repo and creates its store index", async () => {
    const name = `claude-md-repos-${process.pid}-${Date.now()}`;
    await ensureWorkspaceDir(name);
    // Simulate two mounted worktrees (api-gw on two branches → one repo) plus web.
    const repos = workspacePath(name);
    await mkdir(join(repos, "repos", "api-gw__feat-a"), { recursive: true });
    await mkdir(join(repos, "repos", "api-gw__feat-b"), { recursive: true });
    await mkdir(join(repos, "repos", "web__main"), { recursive: true });

    expect(await mountedRepoSubdirs(name)).toEqual(["api-gw", "web"]);

    await syncWorkspaceClaudeMd(name);
    const body = await readFile(join(repos, "CLAUDE.md"), "utf8");
    expect(body).not.toContain("@../../knowledge"); // inlined, not imported
    expect(body).toContain("## api-gw (project knowledge)");
    expect(body).toContain("## web (project knowledge)");
    // Per-repo indexes were still created in the store (for recall / browsing).
    expect(await readFile(knowledgeProjectIndexPath("api-gw"), "utf8")).toContain("# api-gw");
    expect(await readFile(knowledgeProjectIndexPath("web"), "utf8")).toContain("# web");
  });

  test("scaffolds an intent-only GOAL.md placeholder with the unfilled marker", async () => {
    const name = `goal-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const goal = await readFile(join(dir, "GOAL.md"), "utf8");
    expect(goal).toContain("# Goal");
    expect(goal).toContain("servant:goal:unfilled");
    expect(goal).toContain("## Mission");
    expect(goal).toContain("## KPIs / success signals");
    expect(goal).toContain("## Out of scope");
  });

  test("does not overwrite a GOAL.md the user has filled in", async () => {
    const name = `goal-preserve-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const path = join(dir, "GOAL.md");
    await writeFile(path, "# Goal\n\n## Mission\nShip the thing.\n");
    await ensureWorkspaceDir(name);
    const body = await readFile(path, "utf8");
    expect(body).toBe("# Goal\n\n## Mission\nShip the thing.\n");
  });

  test("scaffolds CONTEXT.md, briefs/INDEX.md, plans/INDEX.md, and context/INDEX.md", async () => {
    const name = `scaffold-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);

    const contextMd = await readFile(join(dir, "CONTEXT.md"), "utf8");
    expect(contextMd).toContain("# Context");

    const briefsIndex = await readFile(join(dir, "briefs", "INDEX.md"), "utf8");
    expect(briefsIndex).toContain("# Briefs");

    const plansIndex = await readFile(join(dir, "plans", "INDEX.md"), "utf8");
    expect(plansIndex).toContain("# Plans");

    const contextIndex = await readFile(join(dir, "context", "INDEX.md"), "utf8");
    expect(contextIndex).toContain("# Context");
  });

  test("does not overwrite scaffold files that the user has edited", async () => {
    const name = `scaffold-preserve-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);

    const briefsIndex = join(dir, "briefs", "INDEX.md");
    await writeFile(briefsIndex, "# Briefs\n\n- existing entry\n");

    await ensureWorkspaceDir(name);

    const body = await readFile(briefsIndex, "utf8");
    expect(body).toBe("# Briefs\n\n- existing entry\n");
  });
});

describe("isGoalUnfilled", () => {
  test("true for a missing workspace, true for a fresh placeholder, false once filled", async () => {
    const name = `goal-state-${process.pid}-${Date.now()}`;
    expect(await isGoalUnfilled(name)).toBe(true); // no workspace yet

    const dir = await ensureWorkspaceDir(name);
    expect(await isGoalUnfilled(name)).toBe(true); // placeholder still has the marker

    await writeFile(join(dir, "GOAL.md"), "# Goal\n\n## Mission\nShip it.\n");
    expect(await isGoalUnfilled(name)).toBe(false); // marker gone
  });
});

describe("detectWorkspaceNameFromCwd", () => {
  const root = "/Users/me/.ai_servant/workspaces";

  test("returns name when cwd is exactly <workspaces-root>/<name>", () => {
    expect(detectWorkspaceNameFromCwd(join(root, "foo"), root)).toBe("foo");
  });

  test("returns name for any depth under <workspaces-root>/<name>", () => {
    expect(detectWorkspaceNameFromCwd(join(root, "foo", "src", "lib"), root)).toBe("foo");
  });

  test("returns null when cwd is the root itself", () => {
    expect(detectWorkspaceNameFromCwd(root, root)).toBeNull();
  });

  test("returns null when cwd is outside the root", () => {
    expect(detectWorkspaceNameFromCwd("/Users/me/other/place", root)).toBeNull();
  });

  test("returns null when the first segment is not a valid workspace name", () => {
    expect(detectWorkspaceNameFromCwd(join(root, ".hidden", "x"), root)).toBeNull();
    expect(detectWorkspaceNameFromCwd(join(root, "-flag"), root)).toBeNull();
  });

  test("resolves relative paths", () => {
    expect(detectWorkspaceNameFromCwd(`${root}/foo/./bar`, root)).toBe("foo");
  });
});
