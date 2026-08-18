import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HubApiRunner,
  importHub,
  parseBlockedBy,
  parseClaim,
  parseGhIssues,
  parseParentRef,
} from "../src/core/board/import-hub.ts";
import {
  addComment,
  closeBoard,
  findTicket,
  listBoards,
  listTickets,
  requireTicket,
  ticketActions,
  updateTicket,
} from "../src/core/board/store.ts";
import { setRootOverride } from "../src/core/paths.ts";
import { computeFrontier, readTasks } from "../src/core/tasks.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-import-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const AT = "2026-08-13T10:00:00.000Z";

interface FakeComment {
  body: string;
  id?: string | undefined;
  author?: string;
  createdAt?: string;
}

interface FakeIssue {
  number: number;
  title: string;
  state?: string;
  labels?: string[];
  body?: string;
  comments?: (string | FakeComment)[];
}

/** Ids are per-issue and stable across runs, exactly as GitHub's are. */
const asComment = (issue: number, raw: string | FakeComment, index: number) => {
  const c: FakeComment = typeof raw === "string" ? { body: raw } : raw;
  return {
    id: c.id === undefined ? `IC_${issue}_${index}` : c.id,
    author: { login: c.author ?? "Barak-Zen" },
    body: c.body,
    createdAt: c.createdAt ?? "2026-08-13T08:00:00Z",
  };
};

const listing = (issues: FakeIssue[]) =>
  JSON.stringify(
    issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state ?? "OPEN",
      url: `https://github.com/acme/hub/issues/${i.number}`,
      labels: (i.labels ?? []).map((name) => ({ name })),
      body: i.body ?? "",
      comments: (i.comments ?? []).map((c, n) => asComment(i.number, c, n)),
    })),
  );

/** A `gh api` answering the summary call and the per-issue native-dependency calls. */
function fakeNative(blockers: Record<number, number[]>): HubApiRunner {
  return async (args) => {
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

const noNative: HubApiRunner = async () => "[]";

const runImport = (issues: FakeIssue[], apiRunner: HubApiRunner = noNative) =>
  importHub("acme/hub", { runner: async () => listing(issues), apiRunner, now: AT });

describe("hub-shaped parsing", () => {
  test("parseGhIssues derives the workspace from the ws: label", () => {
    const issues = parseGhIssues(
      listing([
        { number: 1, title: "fix login", labels: ["ws:auth", "ticket"] },
        { number: 3, title: "orphan" },
      ]),
    );
    expect(issues[0]).toMatchObject({ number: 1, workspace: "auth" });
    expect(issues[0]?.labels).toEqual(["ws:auth", "ticket"]);
    expect(issues[1]?.workspace).toBeNull();
  });

  test("parseGhIssues returns [] on malformed json", () => {
    expect(parseGhIssues("not json")).toEqual([]);
    expect(parseGhIssues("{}")).toEqual([]);
  });

  test("parseBlockedBy reads the inline line", () => {
    expect(parseBlockedBy("Some body.\n\nBlocked by: #13, #14\nmore")).toEqual([13, 14]);
    expect(parseBlockedBy("blocked by #7")).toEqual([7]);
    expect(parseBlockedBy("no dependency here")).toEqual([]);
    expect(parseBlockedBy("Blocked by:\n#17")).toEqual([17]);
    // A blank line ends the thought — otherwise the marker invents an edge from later prose.
    expect(parseBlockedBy("Blocked by:\n\nSomething else about #42.")).toEqual([]);
  });

  test("parseBlockedBy reads the bulleted section, and only its list items", () => {
    expect(parseBlockedBy("## Blocked by\n\n- #15 — servant summon\n- #16\n")).toEqual([15, 16]);
    expect(parseBlockedBy("## Blocked by:\n\n- #15 — servant summon\n")).toEqual([15]);
    expect(parseBlockedBy("## Blocked by\n\nNone — can start immediately.\n")).toEqual([]);
    // A bulleted "None" is the same statement, and what follows it is usually what this ticket
    // should go *before* — reading those as blockers reverses the edge (majordomo#29 did exactly
    // this, and closed a cycle with #28).
    expect(
      parseBlockedBy(
        "## Blocked by\n\nBlocked by: none\n\n- None — can start immediately, and should go before #24, #26 and #28.\n",
      ),
    ).toEqual([]);
    // Bounded at the next heading: a number below it is discussion, not a dependency.
    expect(parseBlockedBy("## Blocked by\n\n- #15\n\n## Notes\n\nSee #99.\n")).toEqual([15]);
  });

  test("parseBlockedBy unions both textual forms and ignores code", () => {
    const body = "Blocked by: #13\n\n## Blocked by\n\n- #14\n";
    expect(parseBlockedBy(body).toSorted((a, b) => a - b)).toEqual([13, 14]);
    // Code is quotation: a ticket documenting the format must not acquire the example's blockers.
    expect(parseBlockedBy("An inline `Blocked by: #15, #17` line is one of the forms.")).toEqual(
      [],
    );
    expect(parseBlockedBy("This is similar to #42 but simpler.")).toEqual([]);
  });

  test("parseParentRef finds the map a child hangs off", () => {
    expect(parseParentRef("Part of #40\n\nsome body")).toBe(40);
    expect(parseParentRef("**Part of** #40")).toBe(40);
    expect(parseParentRef("no parent here")).toBeNull();
  });

  test("parseClaim takes the last servant claim comment", () => {
    const held = parseClaim([
      { body: "unrelated" },
      { body: "<!-- servant:claim -->\n**Claim:** `x-t1` — since 2026-01-01T00:00:00.000Z" },
    ]);
    expect(held).toEqual({ kind: "held", session: "x-t1", at: "2026-01-01T00:00:00.000Z" });
    const released = parseClaim([
      { body: "<!-- servant:claim -->\n**Claim:** `x-t1` — since 2026-01-01T00:00:00.000Z" },
      { body: "<!-- servant:claim -->\n**Claim released:** `x-t1` — at 2026-01-02T00:00:00.000Z" },
    ]);
    expect(released?.kind).toBe("released");
    // A transfer names two sessions; the one taking it over wins.
    const transferred = parseClaim([
      {
        body: "<!-- servant:claim -->\n**Claim transferred:** `x-t1` → `x-t2` — since 2026-01-03T00:00:00.000Z",
      },
    ]);
    expect(transferred?.session).toBe("x-t2");
  });
});

describe("importing the hub", () => {
  test("every ws:-labeled issue lands on its board with its number preserved as the seq", async () => {
    const report = await runImport([
      { number: 72, title: "spec", labels: ["ws:kanban", "spec"] },
      { number: 76, title: "store", labels: ["ws:kanban", "ticket"] },
      { number: 17, title: "elsewhere", labels: ["ws:other"] },
    ]);
    expect(report.created).toBe(3);
    expect(report.boards).toEqual(["kanban", "other"]);
    expect(listBoards()).toEqual(["kanban", "other"]);
    expect(requireTicket("kanban", 76).title).toBe("store");
    // The ws: label was membership; it is structural now, so it does not survive as a label.
    expect(requireTicket("kanban", 76).labels).toEqual(["ticket"]);
    expect(requireTicket("other", 17).workspace).toBe("other");
  });

  test("closed issues come over too, so no decision index turns into dead links", async () => {
    await runImport([
      { number: 1, title: "open one", labels: ["ws:kanban"] },
      { number: 2, title: "shipped", state: "CLOSED", labels: ["ws:kanban"] },
    ]);
    expect(requireTicket("kanban", 1).status).toBe("todo");
    expect(requireTicket("kanban", 2).status).toBe("done");
    expect(listTickets({ workspace: "kanban", state: "all" })).toHaveLength(2);
  });

  test("an issue with no ws: label is reported, not silently dropped", async () => {
    const report = await runImport([{ number: 5, title: "stray" }]);
    expect(report.created).toBe(0);
    expect(report.skipped).toEqual([`#5 "stray" — no ws: label, so no board to join`]);
  });

  test("blocking arrives from all three encodings at once", async () => {
    const report = await runImport(
      [
        { number: 10, title: "core", labels: ["ws:k"] },
        { number: 11, title: "second", labels: ["ws:k"] },
        { number: 12, title: "third", labels: ["ws:k"] },
        {
          number: 13,
          title: "waits on everything",
          labels: ["ws:k"],
          body: "Blocked by: #10\n\n## Blocked by\n\n- #11\n",
        },
      ],
      fakeNative({ 13: [12] }),
    );
    expect(report.edges).toBe(3);
    const waiting = requireTicket("k", 13);
    const blockerSeqs = waiting.blockedBy
      .map((id) => listTickets().find((t) => t.id === id)?.seq)
      .toSorted((a, b) => (a ?? 0) - (b ?? 0));
    expect(blockerSeqs).toEqual([10, 11, 12]);
  });

  test("a blocker outside the import is reported as a lost edge", async () => {
    const report = await runImport([
      { number: 13, title: "waits", labels: ["ws:k"], body: "Blocked by: #999" },
    ]);
    expect(report.edges).toBe(0);
    expect(report.skipped).toEqual(["#13 — blocker #999 was not imported, so that edge is lost"]);
  });

  test("a cycle in the hub's edges is refused and reported rather than written", async () => {
    const report = await runImport([
      { number: 1, title: "a", labels: ["ws:k"], body: "Blocked by: #2" },
      { number: 2, title: "b", labels: ["ws:k"], body: "Blocked by: #1" },
    ]);
    expect(report.edges).toBe(1);
    expect(report.skipped.some((s) => /cycle/i.test(s))).toBe(true);
  });

  test("an edge may cross boards, because it is stored against the global id", async () => {
    await runImport([
      { number: 30, title: "shared", labels: ["ws:platform"] },
      { number: 31, title: "consumer", labels: ["ws:app"], body: "Blocked by: #30" },
    ]);
    const shared = requireTicket("platform", 30);
    const consumer = requireTicket("app", 31);
    expect(consumer.blockedBy).toEqual([shared.id]);
    // Renumbering the blocker's seq cannot break the edge.
    updateTicket(shared, { seq: 5 }, { now: AT });
    expect(requireTicket("app", 31).blockedBy).toEqual([shared.id]);
    expect(
      computeFrontier(readTasks(), { known: false }, { workspace: "app" }).blocked,
    ).toHaveLength(1);
  });

  test("a live Claim is carried over, so a session mid-flight keeps its address", async () => {
    const report = await runImport([
      {
        number: 76,
        title: "store",
        labels: ["ws:kanban"],
        comments: [
          "<!-- servant:claim -->\n**Claim:** `servant-kanban-t76` — since 2026-08-13T11:56:39.465Z",
        ],
      },
      {
        number: 75,
        title: "cleanup",
        labels: ["ws:kanban"],
        comments: [
          "<!-- servant:claim -->\n**Claim:** `servant-kanban-t75` — since 2026-08-13T09:00:00.000Z",
          "<!-- servant:claim -->\n**Claim released:** `servant-kanban-t75` — at 2026-08-13T10:00:00.000Z",
        ],
      },
    ]);
    expect(report.claims).toBe(1);
    expect(requireTicket("kanban", 76).claim).toEqual({
      session: "servant-kanban-t76",
      at: "2026-08-13T11:56:39.465Z",
    });
    // A released Claim is nobody's — there is nothing to carry over.
    expect(requireTicket("kanban", 75).claim).toBeNull();
    expect(ticketActions(requireTicket("kanban", 76)).map((a) => a.kind)).toEqual([
      "created",
      "claimed",
    ]);
  });

  test("map children keep their parent", async () => {
    const report = await runImport([
      { number: 40, title: "the map", labels: ["ws:k", "wayfinder:map"] },
      {
        number: 41,
        title: "a question",
        labels: ["ws:k", "wayfinder:research"],
        body: "Part of #40\n\nwhat about auth?",
      },
      { number: 42, title: "orphan child", labels: ["ws:k"], body: "Part of #999" },
    ]);
    expect(report.parents).toBe(1);
    expect(requireTicket("k", 41).parentId).toBe(requireTicket("k", 40).id);
    expect(report.skipped).toContain("#42 — parent #999 was not imported");
  });

  test("re-running changes nothing, and does not stamp back over local progress", async () => {
    const issues: FakeIssue[] = [
      { number: 10, title: "core", labels: ["ws:k"] },
      { number: 11, title: "waits", labels: ["ws:k"], body: "Blocked by: #10" },
      {
        number: 12,
        title: "held",
        labels: ["ws:k"],
        comments: ["<!-- servant:claim -->\n**Claim:** `k-t12` — since 2026-08-13T09:00:00.000Z"],
      },
    ];
    const first = await runImport(issues);
    expect(first).toMatchObject({ created: 3, updated: 0, edges: 1, claims: 1 });

    // Local progress the hub knows nothing about.
    updateTicket(requireTicket("k", 10), { status: "in_progress" }, { now: AT });

    const second = await runImport(issues);
    expect(second).toMatchObject({ created: 0, updated: 3, edges: 0, claims: 0, parents: 0 });
    expect(second.skipped).toEqual([]);
    expect(requireTicket("k", 10).status).toBe("in_progress");
    expect(requireTicket("k", 11).blockedBy).toHaveLength(1);
    expect(ticketActions(requireTicket("k", 12)).map((a) => a.kind)).toEqual([
      "created",
      "claimed",
    ]);
  });

  test("a re-run does reopen a ticket the hub reopened, and close one it closed", async () => {
    await runImport([{ number: 10, title: "core", labels: ["ws:k"] }]);
    await runImport([{ number: 10, title: "core", state: "CLOSED", labels: ["ws:k"] }]);
    expect(requireTicket("k", 10).status).toBe("done");
    await runImport([{ number: 10, title: "core", state: "OPEN", labels: ["ws:k"] }]);
    expect(requireTicket("k", 10).status).toBe("todo");
  });

  test("the imported board answers the frontier with no network of any kind", async () => {
    await runImport([
      { number: 75, title: "cleanup", labels: ["ws:kanban"] },
      { number: 76, title: "store", labels: ["ws:kanban"] },
      { number: 77, title: "viewer", labels: ["ws:kanban"], body: "Blocked by: #76" },
    ]);
    const f = computeFrontier(readTasks(), { known: true, liveSessions: [] });
    expect(f.ready.map((t) => t.seq)).toEqual([75, 76]);
    expect(f.blocked.map((b) => b.ticket.seq)).toEqual([77]);
    expect(findTicket("kanban", 77)?.url).toBe("http://127.0.0.1:7787/w/kanban/t/77");
  });

  test("comments come over with their author and their timestamp", async () => {
    const report = await runImport([
      {
        number: 77,
        title: "viewer",
        labels: ["ws:kanban"],
        comments: [
          { body: "Variant B won: the rail reads as a map.", createdAt: "2026-08-14T09:00:00Z" },
          { body: "One criterion needed refining.", author: "someone-else" },
        ],
      },
    ]);
    expect(report.comments).toBe(2);
    const carried = ticketActions(requireTicket("kanban", 77)).filter((a) => a.kind === "comment");
    expect(carried.map((c) => [c.actor, c.body, c.at])).toEqual([
      ["Barak-Zen", "Variant B won: the rail reads as a map.", "2026-08-14T09:00:00Z"],
      ["someone-else", "One criterion needed refining.", "2026-08-13T08:00:00Z"],
    ]);
    // A hub author is a person, not a servant session — nothing may be invented in that column.
    expect(carried.every((c) => c.session === null)).toBe(true);
  });

  test("a re-run carries no comment twice, and leaves what was written here alone", async () => {
    const issues: FakeIssue[] = [
      { number: 77, title: "viewer", labels: ["ws:kanban"], comments: ["the verdict"] },
    ];
    const first = await runImport(issues);
    expect(first.comments).toBe(1);

    const ticket = { workspace: "kanban", seq: 77 };
    addComment(ticket, "and a note written on the board since", { session: "kanban-t77" });

    // The hub gained one comment between the runs, which is the case that must still work.
    issues[0]?.comments?.push("a later thought");
    const second = await runImport(issues);
    expect(second.comments).toBe(1);

    const bodies = ticketActions(ticket)
      .filter((a) => a.kind === "comment")
      .map((c) => c.body);
    expect(bodies).toEqual([
      "the verdict",
      "and a note written on the board since",
      "a later thought",
    ]);

    // A third run, with nothing new on the hub, is a no-op.
    expect((await runImport(issues)).comments).toBe(0);
    expect(ticketActions(ticket).filter((a) => a.kind === "comment")).toHaveLength(3);
  });

  test("claim-protocol comments are counted rather than carried as comments", async () => {
    const report = await runImport([
      {
        number: 76,
        title: "store",
        labels: ["ws:kanban"],
        comments: [
          "<!-- servant:claim -->\n**Claim:** `kanban-t76` — since 2026-08-13T09:00:00.000Z",
          "the reasoning worth keeping",
          "<!-- servant:claim -->\n**Claim released:** `kanban-t76` — at 2026-08-13T10:00:00.000Z",
        ],
      },
    ]);
    expect(report).toMatchObject({ comments: 1, claimComments: 2 });
    expect(ticketActions(requireTicket("kanban", 76)).map((a) => a.kind)).toEqual([
      "created",
      "comment",
    ]);
  });

  test("a comment with no id is reported rather than carried un-deduplicable", async () => {
    const report = await runImport([
      {
        number: 5,
        title: "odd one",
        labels: ["ws:kanban"],
        comments: [{ body: "no id here", id: "", createdAt: "2026-08-14T09:00:00Z" }],
      },
    ]);
    expect(report.comments).toBe(0);
    expect(report.skipped).toEqual([
      "#5 — a comment by Barak-Zen at 2026-08-14T09:00:00Z has no id, so it cannot be carried without risking a duplicate on the next run",
    ]);
  });

  test("two hub issues may carry identically worded comments", async () => {
    const report = await runImport([
      { number: 1, title: "a", labels: ["ws:k"], comments: ["done"] },
      { number: 2, title: "b", labels: ["ws:k"], comments: ["done"] },
    ]);
    expect(report.comments).toBe(2);
  });

  test("the import only ever reads GitHub — no call it makes can mutate the hub", async () => {
    const apiCalls: (readonly string[])[] = [];
    const hubArgs: string[] = [];
    await importHub("acme/hub", {
      runner: async (repo) => {
        hubArgs.push(repo);
        return listing([
          { number: 1, title: "core", labels: ["ws:k"], comments: ["a verdict"] },
          { number: 2, title: "waits", labels: ["ws:k"], body: "Blocked by: #1" },
        ]);
      },
      apiRunner: async (args) => {
        apiCalls.push(args);
        return fakeNative({ 2: [1] })(args);
      },
      now: AT,
    });
    // The issue read is handed a repo slug and nothing else, so it has no way to name a mutation.
    expect(hubArgs).toEqual(["acme/hub"]);
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const args of apiCalls) {
      // `gh api` defaults to GET; a write needs one of these, and none is ever passed.
      for (const flag of ["-X", "--method", "-f", "-F", "--field", "--input"]) {
        expect(args).not.toContain(flag);
      }
      expect(args[0]).toMatch(/^repos\/acme\/hub\//);
    }
  });

  test("native dependencies that cannot be read degrade to the textual forms", async () => {
    const report = await importHub("acme/hub", {
      runner: async () =>
        listing([
          { number: 1, title: "core", labels: ["ws:k"] },
          { number: 2, title: "waits", labels: ["ws:k"], body: "Blocked by: #1" },
        ]),
      apiRunner: async () => {
        throw new Error("offline");
      },
      now: AT,
    });
    expect(report.edges).toBe(1);
    expect(requireTicket("k", 2).blockedBy).toEqual([requireTicket("k", 1).id]);
  });
});
