import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { setRootOverride } from "../src/core/paths.ts";

let scratch: string;
let aiServantRootDir: string;
let codeRoot: string;
let privateRoot: string;

async function makeFakeRepo(path: string) {
  await mkdir(join(path, ".git"), { recursive: true });
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-disc-test-")));
  aiServantRootDir = join(scratch, ".ai_servant");
  codeRoot = join(scratch, "code");
  privateRoot = join(scratch, "private");

  await mkdir(aiServantRootDir, { recursive: true });
  await mkdir(codeRoot, { recursive: true });
  await mkdir(privateRoot, { recursive: true });

  // Two distinct repos
  await makeFakeRepo(join(codeRoot, "alpha"));
  await makeFakeRepo(join(privateRoot, "beta"));
  // Collision: "dupe" in both roots
  await makeFakeRepo(join(codeRoot, "dupe"));
  await makeFakeRepo(join(privateRoot, "dupe"));
  // Nested under aiServantRootDir — must be excluded
  await makeFakeRepo(join(aiServantRootDir, "workspaces", "ws1", "repos", "shadow", "main"));

  setRootOverride(aiServantRootDir);
});

afterAll(async () => {
  setRootOverride(null);
  await rm(scratch, { recursive: true, force: true });
});

const { discoverRepos } = await import("../src/core/repo-discovery.ts");

function names(repos: { name: string }[]): string[] {
  return repos.map((r) => r.name).sort();
}

describe("discoverRepos", () => {
  const config = {
    version: 1,
    repoSearchRoots: [] as string[],
    scanMaxDepth: 4,
  };

  test("finds repos in configured roots and excludes anything under aiServantRoot", async () => {
    config.repoSearchRoots = [codeRoot, privateRoot];
    const repos = await discoverRepos(config, { refresh: true });
    expect(names(repos)).toEqual(["alpha", "beta", "dupe", "dupe"]);
    expect(repos.find((r) => r.path.startsWith(aiServantRootDir))).toBeUndefined();
  });

  test("marks colliding basenames as collides:true", async () => {
    const repos = await discoverRepos(config, { refresh: true });
    const dupes = repos.filter((r) => r.name === "dupe");
    expect(dupes.length).toBe(2);
    expect(dupes.every((r) => r.collides === true)).toBe(true);
    const alpha = repos.find((r) => r.name === "alpha");
    expect(alpha?.collides).toBeFalsy();
  });

  test("returns cached results when root mtimes are unchanged", async () => {
    await discoverRepos(config, { refresh: true });
    const cachedMtime = (await stat(codeRoot)).mtime;

    // Add a new repo (mutates codeRoot mtime), then reset codeRoot mtime to match cache.
    const sneaked = join(codeRoot, "sneaky-subdir-x", "gamma");
    await makeFakeRepo(sneaked);
    await utimes(codeRoot, cachedMtime, cachedMtime);

    const repos = await discoverRepos(config);
    expect(names(repos)).toEqual(["alpha", "beta", "dupe", "dupe"]);

    // Bump the mtime to force invalidation
    const future = new Date(Date.now() + 60_000);
    await utimes(codeRoot, future, future);
    const repos2 = await discoverRepos(config);
    expect(names(repos2)).toContain("gamma");
  });
});
