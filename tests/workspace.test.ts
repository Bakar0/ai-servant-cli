import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
  readWorkspaceAgent,
  syncWorkspaceAgentsMd,
  syncWorkspaceClaudeMd,
  writeWorkspaceAgent,
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

  test("scaffolds a per-workspace .claude/settings.json with the SessionEnd enqueue hooks", async () => {
    const name = `settings-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
    // SessionEnd carries both servant enqueue hooks: knowledge extraction + insight judgment.
    const commands = (settings.hooks?.SessionEnd ?? []).flatMap(
      (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
    );
    expect(commands).toEqual([
      "servant extract-memories --from-hook",
      "servant insights-judge --from-hook",
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
    const mergedCommands = settings.hooks.SessionEnd.flatMap(
      (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
    );
    expect(mergedCommands).toEqual([
      "servant extract-memories --from-hook",
      "servant insights-judge --from-hook",
    ]);
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
    // extraction hook preserved on SessionEnd; the judgment hook is healed in alongside it
    const healedCommands = settings.hooks.SessionEnd.flatMap(
      (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
    );
    expect(healedCommands).toEqual([
      "servant extract-memories --from-hook",
      "servant insights-judge --from-hook",
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

  test("scaffolds AGENTS.md as the Codex twin: inlines root conventions + GOAL + knowledge, no @-imports", async () => {
    const name = `agents-md-${process.pid}-${Date.now()}`;
    // A root conventions doc (what CLAUDE.md would @-import) must be inlined into AGENTS.md.
    await writeFile(join(tmpRoot, "CLAUDE.md"), "# Root conventions\nBe a good servant.\n");
    await ensureWorkspaceDir(name);
    const repos = workspacePath(name);
    await mkdir(join(repos, "repos", "api-gw__main"), { recursive: true });
    await syncWorkspaceAgentsMd(name);

    const agents = await readFile(join(repos, "AGENTS.md"), "utf8");
    expect(agents).toContain("Managed by servant"); // header
    expect(agents).not.toMatch(/^@/m); // inlined, never @-imported
    expect(agents).toContain("# Root conventions"); // root doc inlined
    expect(agents).toContain("Be a good servant.");
    expect(agents).toContain("# Workspace goal (GOAL.md)"); // GOAL inlined
    expect(agents).toContain("## Mission");
    expect(agents).toContain("## api-gw (project knowledge)"); // same knowledge section as CLAUDE.md

    // Both docs coexist so the workspace works under either backend.
    expect(await stat(join(repos, "CLAUDE.md"))).toBeTruthy();
  });

  test("records and reads back the workspace's agent backend (null before any is set)", async () => {
    const name = `agent-marker-${process.pid}-${Date.now()}`;
    await ensureWorkspaceDir(name);
    expect(await readWorkspaceAgent(name)).toBeNull();
    await writeWorkspaceAgent(name, "codex");
    expect(await readWorkspaceAgent(name)).toBe("codex");
    // idempotent + overwritable
    await writeWorkspaceAgent(name, "codex");
    expect(await readWorkspaceAgent(name)).toBe("codex");
    await writeWorkspaceAgent(name, "claude-code");
    expect(await readWorkspaceAgent(name)).toBe("claude-code");
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

  test("scaffolds CONTEXT.md, docs/agents/* skills config, and a docs/adr/ dir", async () => {
    const name = `scaffold-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);

    const contextMd = await readFile(join(dir, "CONTEXT.md"), "utf8");
    expect(contextMd).toContain("# Context");

    // Tasks/plans are tickets on the board now — no briefs/ or plans/ dirs.
    expect(existsSync(join(dir, "briefs"))).toBe(false);
    expect(existsSync(join(dir, "plans"))).toBe(false);

    // mattpocock skills config, pointed at this workspace's own board rather than at `gh`.
    const tracker = await readFile(join(dir, "docs", "agents", "issue-tracker.md"), "utf8");
    expect(tracker).toContain("servant ticket new");
    expect(tracker).toContain(`--ws ${name}`);
    expect(tracker).not.toContain("gh issue");
    const domain = await readFile(join(dir, "docs", "agents", "domain.md"), "utf8");
    expect(domain).toContain("docs/adr/");
    await readFile(join(dir, "docs", "agents", "triage-labels.md"), "utf8");

    expect(existsSync(join(dir, "docs", "adr"))).toBe(true);
  });

  test("does not overwrite the workspace's own prose", async () => {
    const name = `scaffold-preserve-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);

    const context = join(dir, "CONTEXT.md");
    await writeFile(context, "# Context\n\n- existing entry\n");

    await ensureWorkspaceDir(name);

    expect(await readFile(context, "utf8")).toBe("# Context\n\n- existing entry\n");
  });

  test("re-scaffolding leaves an up-to-date generated agent doc byte-identical", async () => {
    const name = `scaffold-stable-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const tracker = join(dir, "docs", "agents", "issue-tracker.md");
    const first = await readFile(tracker, "utf8");

    await ensureWorkspaceDir(name);

    expect(await readFile(tracker, "utf8")).toBe(first);
    expect(first.startsWith("<!-- servant:agent-doc v=")).toBe(true);
  });

  // The case that matters: every workspace that existed before the tracker moved has an unstamped
  // issue-tracker.md telling agents to run `gh issue create`, and it must not survive a spawn.
  test("an agent doc written before stamping existed is rewritten", async () => {
    const name = `scaffold-legacy-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const tracker = join(dir, "docs", "agents", "issue-tracker.md");
    await writeFile(
      tracker,
      "# Issue tracker: GitHub (servant hub)\n\ngh issue create --repo acme/hub\n",
    );

    await ensureWorkspaceDir(name);

    const body = await readFile(tracker, "utf8");
    expect(body).toContain("servant ticket new");
    expect(body).not.toContain("gh issue create");
  });

  test("a stamped agent doc is rewritten when the generated content moves", async () => {
    const name = `scaffold-restamp-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const tracker = join(dir, "docs", "agents", "issue-tracker.md");
    // A stamp from some earlier generation of the prose, with content to match.
    await writeFile(tracker, "<!-- servant:agent-doc v=000000000000 -->\nold prose\n");

    await ensureWorkspaceDir(name);

    expect(await readFile(tracker, "utf8")).toContain("servant ticket new");
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
