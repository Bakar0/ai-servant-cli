import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
const originalEnv = process.env.AI_SERVANT_ROOT;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-ws-test-"));
  process.env.AI_SERVANT_ROOT = tmpRoot;
});

afterAll(async () => {
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AI_SERVANT_ROOT");
  else process.env.AI_SERVANT_ROOT = originalEnv;
  await rm(tmpRoot, { recursive: true, force: true });
});

const { assertValidWorkspaceName, detectWorkspaceNameFromCwd, ensureWorkspaceDir } = await import(
  "../src/core/workspace.ts"
);
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

  test("writes a CLAUDE.md pointer that imports the servant-root CLAUDE.md", async () => {
    const name = `claude-md-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const body = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(body).toBe("@../../CLAUDE.md\n");
  });

  test("restores the CLAUDE.md pointer if it has been tampered with", async () => {
    const name = `claude-md-restore-${process.pid}-${Date.now()}`;
    const dir = await ensureWorkspaceDir(name);
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "tampered");
    await ensureWorkspaceDir(name);
    const body = await readFile(path, "utf8");
    expect(body).toBe("@../../CLAUDE.md\n");
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
