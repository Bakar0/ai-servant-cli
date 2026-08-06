import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";
import { fetchHubTasks, groupByWorkspace, parseGhIssues } from "../src/core/tasks.ts";

let tmpRoot: string;
beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-tasks-test-"));
  setRootOverride(tmpRoot);
});
afterAll(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const SAMPLE = JSON.stringify([
  { number: 1, title: "fix login", state: "OPEN", url: "https://x/1", labels: [{ name: "ws:auth" }, { name: "ticket" }] },
  { number: 2, title: "spec payments", state: "OPEN", url: "https://x/2", labels: [{ name: "ws:pay" }, { name: "spec" }] },
  { number: 3, title: "orphan", state: "OPEN", url: "https://x/3", labels: [] },
]);

describe("parseGhIssues", () => {
  test("extracts labels and derives the ws workspace", () => {
    const issues = parseGhIssues(SAMPLE);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatchObject({ number: 1, title: "fix login", workspace: "auth" });
    expect(issues[0]?.labels).toEqual(["ws:auth", "ticket"]);
    expect(issues[2]?.workspace).toBeNull();
  });

  test("returns [] on malformed json", () => {
    expect(parseGhIssues("not json")).toEqual([]);
    expect(parseGhIssues("{}")).toEqual([]);
  });
});

describe("groupByWorkspace", () => {
  test("buckets by workspace, unlabeled last-sorted, keys sorted", () => {
    const grouped = groupByWorkspace(parseGhIssues(SAMPLE));
    expect([...grouped.keys()]).toEqual(["(unlabeled)", "auth", "pay"]);
    expect(grouped.get("auth")).toHaveLength(1);
  });
});

describe("fetchHubTasks", () => {
  test("caches on success, then serves the cache when gh fails", async () => {
    const ok = await fetchHubTasks("owner/hub", "open", { ghRunner: async () => SAMPLE, now: 123 });
    expect(ok.fromCache).toBe(false);
    expect(ok.issues).toHaveLength(3);

    const fail = await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => {
        throw new Error("offline");
      },
    });
    expect(fail.fromCache).toBe(true);
    expect(fail.cachedAt).toBe(123);
    expect(fail.issues).toHaveLength(3);
  });

  test("no cache + gh failure → empty, not fromCache", async () => {
    const empty = await mkdtemp(join(tmpdir(), "servant-tasks-empty-"));
    setRootOverride(empty);
    const res = await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => {
        throw new Error("offline");
      },
    });
    expect(res.issues).toEqual([]);
    expect(res.fromCache).toBe(false);
    setRootOverride(tmpRoot);
    await rm(empty, { recursive: true, force: true });
  });
});
