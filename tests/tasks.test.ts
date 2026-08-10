import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";
import {
  computeFrontier,
  fetchHubTasks,
  groupByWorkspace,
  type HubIssue,
  parseBlockedBy,
  readNativeBlockers,
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

/** A fake `gh api` answering the summary call and the per-issue dependency calls. */
function fakeNative(blockers: Record<number, number[]>) {
  return async (args: readonly string[]) => {
    const path = args[0] ?? "";
    const per = /issues\/(\d+)\/dependencies/.exec(path);
    if (per) return JSON.stringify((blockers[Number(per[1])] ?? []).map((n) => ({ number: n })));
    return JSON.stringify(
      Object.entries(blockers).map(([n, list]) => ({
        number: Number(n),
        issue_dependencies_summary: { total_blocked_by: list.length },
      })),
    );
  };
}

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

// A blocking edge reaches the hub three ways and only one was read, so a ticket carrying either of
// the other two parsed as having no blockers at all. The failure points the wrong way: it never
// invents a blocker, it only loses one — so the tool says "ready" with confidence about work that
// cannot start, and /servant:handoff spawns a session onto it (majordomo#23).
describe("reading every form a blocking edge takes", () => {
  const TICKETS_SECTION = `## What to build

Something.

## Blocked by

Blocked by: #17, #24

- #17 — Delegate work to Claude by voice
- #24 — Hands session
`;

  test("the inline form keeps working, so no already-written body needs editing", () => {
    expect(parseBlockedBy("Some body.\n\nBlocked by: #13, #14\nmore")).toEqual([13, 14]);
  });

  // The form /to-tickets prescribes, so it is what every future run produces.
  test("the bulleted section is read on its own, with no inline line to help it", () => {
    const body = `## Blocked by

- #15 — servant summon
- #16 — Prefactor: extract spawning
`;
    expect(parseBlockedBy(body).toSorted((a, b) => a - b)).toEqual([15, 16]);
  });

  test("a body carrying both forms contributes their union, never a subset", () => {
    expect(parseBlockedBy(TICKETS_SECTION).toSorted((a, b) => a - b)).toEqual([17, 24]);
  });

  test("the two forms disagreeing still yields the union — losing an edge is the failure", () => {
    const body = `Blocked by: #17

## Blocked by

- #24 — Hands session
`;
    expect(parseBlockedBy(body).toSorted((a, b) => a - b)).toEqual([17, 24]);
  });

  test("'None — can start immediately' declares no blocker", () => {
    const body = "## Blocked by\n\nNone — can start immediately.\n";
    expect(parseBlockedBy(body)).toEqual([]);
  });

  // The section ends where the next heading starts: an issue mentioned further down the body is
  // discussion, not a dependency.
  test("issue numbers after the section has ended are prose, not edges", () => {
    const body = `## Blocked by

- #15 — servant summon

## Notes

This supersedes #99 and relates to #98.
`;
    expect(parseBlockedBy(body)).toEqual([15]);
  });

  test("prose that merely mentions an issue is not an edge", () => {
    expect(parseBlockedBy("This is similar to #42 but simpler.")).toEqual([]);
  });

  test("a body with no blocking section at all has no edges", () => {
    expect(parseBlockedBy("no dependency here")).toEqual([]);
  });
});

describe("native GitHub dependencies as a third form", () => {
  const issue = (number: number, body = "") =>
    ({
      number,
      title: `t${number}`,
      state: "open",
      url: `u/${number}`,
      labels: ["ws:x"],
      workspace: "x",
      blockedBy: parseBlockedBy(body),
      nativeBlockedBy: null,
      claim: null,
    }) satisfies HubIssue;

  const withNative = (i: HubIssue, native: number[]): HubIssue => ({
    ...i,
    nativeBlockedBy: native,
  });

  test("a ticket whose only edge is a native dependency is blocked while that blocker is open", () => {
    const issues = [issue(13), withNative(issue(27), [13])];

    const { ready, blocked } = computeFrontier(issues);

    expect(ready.map((i) => i.number)).toEqual([13]);
    expect(blocked[0]?.issue.number).toBe(27);
    expect(blocked[0]?.openBlockers).toEqual([13]);
  });

  test("native and textual edges contribute their union, never a subset", () => {
    const issues = [issue(13), issue(14), withNative(issue(27, "Blocked by: #13"), [14])];

    const { blocked } = computeFrontier(issues);

    expect(blocked[0]?.openBlockers.toSorted((a, b) => a - b)).toEqual([13, 14]);
  });

  test("the same blocker in both forms is counted once", () => {
    const issues = [issue(13), withNative(issue(27, "Blocked by: #13"), [13])];

    expect(computeFrontier(issues).blocked[0]?.openBlockers).toEqual([13]);
  });

  test("a native blocker that is closed counts as satisfied, as a textual one does", () => {
    const issues = [withNative(issue(27), [17])];

    expect(computeFrontier(issues).ready.map((i) => i.number)).toEqual([27]);
  });

  // AC 7. Native dependencies cost extra API calls, so a hub that cannot answer must leave the
  // command working off the text forms — not fail, and not silently report the ticket as ready
  // when a text form also declares the edge.
  test("dependencies never read at all falls back to the textual edges", () => {
    const issues = [issue(13), issue(27, "Blocked by: #13")];

    expect(computeFrontier(issues).blocked[0]?.openBlockers).toEqual([13]);
  });
});

describe("fetching native dependencies from the hub", () => {
  /** A fake `gh api`: the issue list first, then per-issue dependency reads. */
  function fakeApi(
    summaries: { number: number; total: number }[],
    blockers: Record<number, number[] | "error">,
  ) {
    const calls: string[][] = [];
    const runner = async (args: readonly string[]) => {
      calls.push([...args]);
      const path = args[0] ?? "";
      if (path.includes("/dependencies/blocked_by")) {
        const n = Number(/issues\/(\d+)\//.exec(path)?.[1]);
        const answer = blockers[n];
        if (answer === "error" || answer === undefined) throw new Error("404");
        return JSON.stringify(answer.map((b) => ({ number: b })));
      }
      return JSON.stringify(
        summaries.map((s) => ({
          number: s.number,
          issue_dependencies_summary: { total_blocked_by: s.total },
        })),
      );
    };
    return { runner, calls };
  }

  test("a ticket the hub says has no dependencies reads as an empty list, not as unread", async () => {
    const { runner } = fakeApi([{ number: 13, total: 0 }], {});

    const map = await readNativeBlockers("acme/hub", { runner });

    // [] means "asked, and there are none". null would mean "nobody looked" — a different fact.
    expect(map?.get(13)).toEqual([]);
  });

  test("a ticket with dependencies is asked about, and reports its blockers", async () => {
    const { runner } = fakeApi([{ number: 27, total: 1 }], { 27: [17] });

    const map = await readNativeBlockers("acme/hub", { runner });

    expect(map?.get(27)).toEqual([17]);
  });

  // The summary is what keeps this from being one API call per open ticket.
  test("only tickets the summary says have dependencies are asked about", async () => {
    const { runner, calls } = fakeApi(
      [
        { number: 13, total: 0 },
        { number: 27, total: 1 },
      ],
      { 27: [17] },
    );

    await readNativeBlockers("acme/hub", { runner });

    const asked = calls.filter((c) => (c[0] ?? "").includes("/dependencies/"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.[0]).toContain("/issues/27/");
  });

  // AC 7: a hub that cannot answer must leave the command working off the text forms.
  test("a hub that cannot list issues reports nothing read at all", async () => {
    const map = await readNativeBlockers("acme/hub", {
      runner: async () => {
        throw new Error("gh: could not resolve host");
      },
    });

    expect(map).toBeNull();
  });

  test("an endpoint that does not exist on this hub reports nothing read", async () => {
    const map = await readNativeBlockers("acme/hub", { runner: async () => "not json" });

    expect(map).toBeNull();
  });

  // One ticket failing must not be reported as "that ticket has no blockers" — it is left unread,
  // so the union falls back to whatever the body declares.
  test("one ticket's dependencies failing leaves that ticket unread, not unblocked", async () => {
    const { runner } = fakeApi(
      [
        { number: 26, total: 1 },
        { number: 27, total: 1 },
      ],
      { 26: "error", 27: [17] },
    );

    const map = await readNativeBlockers("acme/hub", { runner });

    expect(map?.has(26)).toBe(false);
    expect(map?.get(27)).toEqual([17]);
  });
});

// The cache is shared by every caller, and only --frontier reads native dependencies. Without
// this, a `servant summon` fetch — which has no use for them — would overwrite the last-known
// native edges with "not read", and the next offline frontier would lose them all over again.
describe("the cache holds on to native edges nobody re-read", () => {
  const listing = JSON.stringify([
    { number: 27, title: "lead", state: "OPEN", url: "u/27", labels: [{ name: "ws:x" }], body: "" },
  ]);

  test("a fetch that read them stores them", async () => {
    const res = await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => listing,
      nativeRunner: fakeNative({ 27: [25] }),
      now: 1,
    });

    expect(res.issues[0]?.nativeBlockedBy).toEqual([25]);
  });

  test("a later fetch that did not read them keeps the ones already known", async () => {
    await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => listing,
      nativeRunner: fakeNative({ 27: [25] }),
      now: 1,
    });

    // The summon path: no native runner, so it asks the hub for nothing extra.
    const plain = await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => listing,
      now: 2,
    });

    expect(plain.issues[0]?.nativeBlockedBy).toEqual([25]);
  });

  test("and the edge survives into the offline snapshot", async () => {
    await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => listing,
      nativeRunner: fakeNative({ 27: [25] }),
      now: 1,
    });
    await fetchHubTasks("owner/hub", "open", { ghRunner: async () => listing, now: 2 });

    const offline = await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => {
        throw new Error("offline");
      },
    });

    expect(offline.fromCache).toBe(true);
    expect(offline.issues[0]?.nativeBlockedBy).toEqual([25]);
  });

  test("a fresh read that finds no dependencies overwrites what was cached", async () => {
    await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => listing,
      nativeRunner: fakeNative({ 27: [25] }),
      now: 1,
    });

    // Asked again, the hub now says there are none — that is knowledge, and it wins.
    const res = await fetchHubTasks("owner/hub", "open", {
      ghRunner: async () => listing,
      nativeRunner: fakeNative({ 27: [] }),
      now: 2,
    });

    expect(res.issues[0]?.nativeBlockedBy).toEqual([]);
  });
});

// majordomo#25. Once a ticket records which session is carrying it, the tool that hands out work
// has to stop offering it. The third state is the useful one: it is how a crashed tab stops
// blocking a ticket for ever.
describe("the frontier reads Claims", () => {
  const claimComment = (session: string, at = "2026-08-09T21:00:00Z") => ({
    body: `<!-- servant:claim -->\n**Claim:** \`${session}\` — since ${at}`,
  });
  const releasedComment = (session: string) => ({
    body: `<!-- servant:claim -->\n**Claim released:** \`${session}\` — at 2026-08-09T22:00:00Z`,
  });

  const listing = (issues: { number: number; body?: string; comments?: { body: string }[] }[]) =>
    JSON.stringify(
      issues.map((i) => ({
        number: i.number,
        title: `t${i.number}`,
        state: "OPEN",
        url: `u/${i.number}`,
        labels: [{ name: "ws:x" }],
        body: i.body ?? "",
        comments: i.comments ?? [],
      })),
    );

  const alive = (...names: string[]) => ({ known: true as const, liveSessions: names });

  test("an unclaimed, unblocked ticket is ready", () => {
    const f = computeFrontier(parseGhIssues(listing([{ number: 13 }])), alive());

    expect(f.ready.map((i) => i.number)).toEqual([13]);
    expect(f.inFlight).toEqual([]);
    expect(f.stale).toEqual([]);
  });

  test("a ticket claimed by a running session is in-flight, and not offered as dispatchable", () => {
    const issues = parseGhIssues(listing([{ number: 25, comments: [claimComment("x-t25")] }]));

    const f = computeFrontier(issues, alive("x-t25"));

    expect(f.ready).toEqual([]);
    expect(f.inFlight[0]?.issue.number).toBe(25);
    expect(f.inFlight[0]?.claim.session).toBe("x-t25");
  });

  test("a ticket claimed by a session that no longer exists is stale", () => {
    const issues = parseGhIssues(listing([{ number: 25, comments: [claimComment("x-t25")] }]));

    const f = computeFrontier(issues, alive("x-t99"));

    expect(f.stale[0]?.issue.number).toBe(25);
    expect(f.stale[0]?.claim.session).toBe("x-t25");
    expect(f.ready).toEqual([]);
  });

  // Staleness is the session being gone — never a clock. An hours-old claim on a live session is
  // in-flight, and a minutes-old claim on a dead one is stale.
  test("an idle-but-alive session keeps its ticket in-flight, however old the Claim", () => {
    const issues = parseGhIssues(
      listing([{ number: 25, comments: [claimComment("x-t25", "2020-01-01T00:00:00Z")] }]),
    );

    const f = computeFrontier(issues, alive("x-t25"));

    expect(f.inFlight[0]?.issue.number).toBe(25);
    expect(f.stale).toEqual([]);
  });

  // Fail closed, exactly as steering does: unknown must never free a resource.
  test("an unreadable registry leaves a claimed ticket in-flight, never stale or ready", () => {
    const issues = parseGhIssues(listing([{ number: 25, comments: [claimComment("x-t25")] }]));

    const f = computeFrontier(issues, { known: false });

    expect(f.inFlight[0]?.liveness).toBe("unknown");
    expect(f.stale).toEqual([]);
    expect(f.ready).toEqual([]);
  });

  test("a released Claim leaves the ticket ready again", () => {
    const issues = parseGhIssues(
      listing([{ number: 25, comments: [claimComment("x-t25"), releasedComment("x-t25")] }]),
    );

    expect(computeFrontier(issues, alive()).ready.map((i) => i.number)).toEqual([25]);
  });

  // Blocked wins: whoever is on it, the prerequisite still does not exist.
  test("a blocked ticket stays blocked even when something is claiming it", () => {
    const issues = parseGhIssues(
      listing([
        { number: 13 },
        { number: 25, body: "Blocked by: #13", comments: [claimComment("x-t25")] },
      ]),
    );

    const f = computeFrontier(issues, alive("x-t25"));

    expect(f.blocked[0]?.issue.number).toBe(25);
    expect(f.inFlight).toEqual([]);
  });

  test("with no liveness given at all, a claimed ticket is still not offered", () => {
    const issues = parseGhIssues(listing([{ number: 25, comments: [claimComment("x-t25")] }]));

    expect(computeFrontier(issues).ready).toEqual([]);
  });
});

// All found in review. Every one of these is the same failure in a different disguise: an edge or
// a Claim quietly lost, so the frontier answers "dispatchable" with confidence about work that
// is not. Losing is the dangerous direction; inventing merely stalls.
describe("edges review found being lost", () => {
  test("a blocker on the line after the marker is still an edge", () => {
    expect(parseBlockedBy("Blocked by:\n#17")).toEqual([17]);
  });

  test("but the marker does not reach across a blank line into unrelated prose", () => {
    expect(parseBlockedBy("Blocked by:\n\nSomething else about #42.")).toEqual([]);
  });

  // A ticket that documents the format — #23 itself does — must not acquire the blockers it is
  // describing. Code spans are quotation, not declaration.
  test("a blocked-by example inside backticks is quotation, not an edge", () => {
    expect(parseBlockedBy("An inline `Blocked by: #15, #17` line is one of the forms.")).toEqual(
      [],
    );
  });

  test("a fenced block inside the section does not end it early", () => {
    const body = "## Blocked by\n\n```sh\n# a comment\n```\n\n- #15 — servant summon\n";
    expect(parseBlockedBy(body)).toEqual([15]);
  });

  test("a heading with trailing punctuation still opens the section", () => {
    expect(parseBlockedBy("## Blocked by:\n\n- #15 — servant summon\n")).toEqual([15]);
  });

  test("a hub with no open issues is 'asked, and there are none' — not 'never asked'", async () => {
    const map = await readNativeBlockers("acme/hub", { runner: async () => "[]" });

    expect(map).not.toBeNull();
    expect(map?.size).toBe(0);
  });
});
