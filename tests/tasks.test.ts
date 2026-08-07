import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";
import {
  computeFrontier,
  fetchHubTasks,
  groupByWorkspace,
  parseBlockedBy,
  parseGhIssues,
} from "../src/core/tasks.ts";

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
  {
    number: 1,
    title: "fix login",
    state: "OPEN",
    url: "https://x/1",
    labels: [{ name: "ws:auth" }, { name: "ticket" }],
  },
  {
    number: 2,
    title: "spec payments",
    state: "OPEN",
    url: "https://x/2",
    labels: [{ name: "ws:pay" }, { name: "spec" }],
  },
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

describe("parseBlockedBy", () => {
  test("pulls issue numbers from a Blocked by line", () => {
    expect(parseBlockedBy("Some body.\n\nBlocked by: #13, #14\nmore")).toEqual([13, 14]);
    expect(parseBlockedBy("blocked by #7")).toEqual([7]);
    expect(parseBlockedBy("no dependency here")).toEqual([]);
  });
});

describe("computeFrontier", () => {
  const FRONTIER = JSON.stringify([
    { number: 13, title: "core", state: "OPEN", url: "u/13", labels: [{ name: "ws:x" }], body: "" },
    {
      number: 14,
      title: "mw",
      state: "OPEN",
      url: "u/14",
      labels: [{ name: "ws:x" }],
      body: "independent",
    },
    {
      number: 15,
      title: "tenant",
      state: "OPEN",
      url: "u/15",
      labels: [{ name: "ws:x" }],
      body: "Blocked by: #13",
    },
    {
      number: 16,
      title: "later",
      state: "OPEN",
      url: "u/16",
      labels: [{ name: "ws:x" }],
      body: "Blocked by: #99",
    },
  ]);

  test("ready = no open blockers; blocked lists only still-open blockers", () => {
    const { ready, blocked } = computeFrontier(parseGhIssues(FRONTIER));
    // #13 and #14 have none; #16's blocker #99 isn't in the open set → treated satisfied → ready.
    expect(ready.map((i) => i.number)).toEqual([13, 14, 16]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.issue.number).toBe(15);
    expect(blocked[0]?.openBlockers).toEqual([13]);
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
