import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceReader } from "../src/core/summons-reader.ts";

let scratch: string;
let scope: string;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-summons-reader-")));
  scope = join(scratch, "scope");
  await mkdir(join(scope, "docs"), { recursive: true });
  await mkdir(join(scope, "node_modules", "junk"), { recursive: true });
  await writeFile(join(scope, "GOAL.md"), "# Goal\n\nShip the talking servant.\n");
  await writeFile(join(scope, "docs", "notes.md"), "delegation happens in Claude\n");
  await writeFile(join(scope, "node_modules", "junk", "index.js"), "delegation\n");
  await writeFile(join(scratch, "secret.txt"), "not in scope\n");
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("the Summons agent's local reads", () => {
  test("reads a file inside the scope", async () => {
    expect(await createWorkspaceReader(scope).readFile("GOAL.md")).toContain(
      "Ship the talking servant.",
    );
  });

  test("finds files by name pattern, skipping dependency noise", async () => {
    const matches = await createWorkspaceReader(scope).glob("**/*.md");

    expect(matches).toEqual(["GOAL.md", "docs/notes.md"]);
  });

  test("finds lines by content, reporting file and line number", async () => {
    const hits = await createWorkspaceReader(scope).grep("delegation", {});

    expect(hits).toEqual(["docs/notes.md:1: delegation happens in Claude"]);
  });

  test("a --repo-scoped session cannot read its way out of the repo", async () => {
    const reader = createWorkspaceReader(scope);

    await expect(reader.readFile("../secret.txt")).rejects.toThrow(/outside this session's scope/);
    await expect(reader.readFile(join(scratch, "secret.txt"))).rejects.toThrow(
      /outside this session's scope/,
    );
  });
});
