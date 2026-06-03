import { afterAll, describe, expect, test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { workspacePath } from "../src/core/paths.ts";
import {
  assertValidWorkspaceName,
  detectWorkspaceNameFromCwd,
  ensureWorkspaceDir,
} from "../src/core/workspace.ts";

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

  afterAll(async () => {
    await rm(workspacePath(testName), { recursive: true, force: true });
  });

  test("creates the workspace directory under ~/.ai_servant and is idempotent", async () => {
    const dir1 = await ensureWorkspaceDir(testName);
    expect(dir1).toBe(workspacePath(testName));
    const s = await stat(dir1);
    expect(s.isDirectory()).toBe(true);

    const dir2 = await ensureWorkspaceDir(testName);
    expect(dir2).toBe(dir1);
  });

  test("rejects invalid names before touching the filesystem", async () => {
    await expect(ensureWorkspaceDir("../evil")).rejects.toThrow();
  });
});

describe("detectWorkspaceNameFromCwd", () => {
  const root = "/Users/me/.ai_servant";

  test("returns name when cwd is exactly ~/.ai_servant/<name>", () => {
    expect(detectWorkspaceNameFromCwd(join(root, "foo"), root)).toBe("foo");
  });

  test("returns name for any depth under ~/.ai_servant/<name>", () => {
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
