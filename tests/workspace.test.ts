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

const { assertValidWorkspaceName, detectWorkspaceNameFromCwd, ensureWorkspaceDir, isGoalUnfilled } =
  await import("../src/core/workspace.ts");
const { workspacePath, workspacesRoot } = await import("../src/core/paths.ts");

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

  test("writes a CLAUDE.md pointer that imports the servant-root CLAUDE.md and GOAL.md", async () => {
    const name = `claude-md-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const body = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(body).toBe("@../../CLAUDE.md\n@GOAL.md\n");
  });

  test("upgrades an old single-import CLAUDE.md pointer to also import GOAL.md", async () => {
    const name = `claude-md-upgrade-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "@../../CLAUDE.md\n");
    await ensureWorkspaceDir(name);
    const body = await readFile(path, "utf8");
    expect(body).toBe("@../../CLAUDE.md\n@GOAL.md\n");
  });

  test("restores the CLAUDE.md pointer if it has been tampered with", async () => {
    const name = `claude-md-restore-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "tampered");
    await ensureWorkspaceDir(name);
    const body = await readFile(path, "utf8");
    expect(body).toBe("@../../CLAUDE.md\n@GOAL.md\n");
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
