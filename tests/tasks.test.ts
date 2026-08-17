import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDependency,
  closeBoard,
  createTicket,
  requireTicket,
  updateTicket,
} from "../src/core/board/store.ts";
import { setRootOverride } from "../src/core/paths.ts";
import {
  type ClaimLiveness,
  type Ticket,
  blockerLabel,
  computeFrontier,
  groupByWorkspace,
  readTasks,
  refreshSessionProjection,
} from "../src/core/tasks.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-tasks-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const AT = "2026-06-16T12:00:00.000Z";
const alive = (...names: string[]): ClaimLiveness => ({ known: true, liveSessions: names });

/** A ticket literal, so the pure frontier logic is driven entirely through injected input. */
function ticket(over: Partial<Ticket> & { id: number; seq: number }): Ticket {
  return {
    workspace: "x",
    title: `t${over.seq}`,
    body: "",
    status: "todo",
    labels: [],
    claim: null,
    parentId: null,
    input: {},
    createdAt: AT,
    updatedAt: AT,
    blockedBy: [],
    blocks: [],
    url: `http://127.0.0.1:7787/w/x/t/${over.seq}`,
    ...over,
  };
}

describe("groupByWorkspace", () => {
  test("buckets by board, keys sorted", () => {
    const grouped = groupByWorkspace([
      ticket({ id: 1, seq: 1, workspace: "pay" }),
      ticket({ id: 2, seq: 1, workspace: "auth" }),
      ticket({ id: 3, seq: 2, workspace: "pay" }),
    ]);
    expect([...grouped.keys()]).toEqual(["auth", "pay"]);
    expect(grouped.get("pay")).toHaveLength(2);
  });
});

describe("computeFrontier — blocking", () => {
  test("ready = no open blockers; blocked lists only the still-open ones", () => {
    const tickets = [
      ticket({ id: 1, seq: 13 }),
      ticket({ id: 2, seq: 14 }),
      ticket({ id: 3, seq: 15, blockedBy: [1] }),
      ticket({ id: 4, seq: 16, blockedBy: [99] }),
    ];
    const { ready, blocked } = computeFrontier(tickets);
    // #16's blocker 99 is not in the set at all → nothing open is in the way → ready.
    expect(ready.map((t) => t.seq)).toEqual([13, 14, 16]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.ticket.seq).toBe(15);
    expect(blocked[0]?.openBlockers).toEqual([1]);
  });

  test("a closed blocker is satisfied, and the ticket becomes ready with no sweep step", () => {
    const blocker = ticket({ id: 1, seq: 13 });
    const waiting = ticket({ id: 2, seq: 15, blockedBy: [1] });
    expect(computeFrontier([blocker, waiting]).blocked).toHaveLength(1);
    expect(
      computeFrontier([{ ...blocker, status: "done" }, waiting]).ready.map((t) => t.seq),
    ).toEqual([15]);
  });

  test("a ticket with several blockers reports only the open subset", () => {
    const tickets = [
      ticket({ id: 1, seq: 13 }),
      ticket({ id: 2, seq: 14, status: "done" }),
      ticket({ id: 3, seq: 15, blockedBy: [1, 2] }),
    ];
    expect(computeFrontier(tickets).blocked[0]?.openBlockers).toEqual([1]);
  });

  test("closed tickets are in no bucket at all", () => {
    const f = computeFrontier([ticket({ id: 1, seq: 13, status: "done" })]);
    expect([f.ready, f.stale, f.inFlight, f.blocked].every((b) => b.length === 0)).toBe(true);
  });

  test("a blocker on another board still blocks, and filtering does not hide it", () => {
    const shared = ticket({ id: 1, seq: 1, workspace: "platform" });
    const consumer = ticket({ id: 2, seq: 4, workspace: "alpha", blockedBy: [1] });
    const f = computeFrontier([shared, consumer], { known: false }, { workspace: "alpha" });
    expect(f.ready).toEqual([]);
    expect(f.blocked[0]?.openBlockers).toEqual([1]);
    // Narrowing to one board bucketed only that board's ticket, not the blocker itself.
    expect(f.blocked).toHaveLength(1);
  });
});

describe("computeFrontier — Claims and liveness", () => {
  const held = (over: Partial<Ticket> & { id: number; seq: number }, session: string) =>
    ticket({ ...over, claim: { session, at: AT } });

  test("an unclaimed ticket is ready", () => {
    expect(computeFrontier([ticket({ id: 1, seq: 13 })], alive()).ready.map((t) => t.seq)).toEqual([
      13,
    ]);
  });

  test("claimed by a live session → in flight, alive", () => {
    const f = computeFrontier([held({ id: 1, seq: 25 }, "x-t25")], alive("x-t25"));
    expect(f.ready).toEqual([]);
    expect(f.inFlight).toHaveLength(1);
    expect(f.inFlight[0]?.liveness).toBe("alive");
    expect(f.inFlight[0]?.claim.session).toBe("x-t25");
  });

  test("claimed by a session that is gone → stale, reclaimable", () => {
    const f = computeFrontier([held({ id: 1, seq: 25 }, "x-t25")], alive("x-t99"));
    expect(f.stale).toHaveLength(1);
    expect(f.stale[0]?.claim.session).toBe("x-t25");
    expect(f.inFlight).toEqual([]);
  });

  test("liveness unknown → in flight, not stale: a ticket we cannot prove is free is not free", () => {
    const f = computeFrontier([held({ id: 1, seq: 25 }, "x-t25")], { known: false });
    expect(f.stale).toEqual([]);
    expect(f.inFlight[0]?.liveness).toBe("unknown");
  });

  test("a live-but-idle session keeps its Claim — idleness is not death", () => {
    // The registry says the session exists; nothing here looks at elapsed time at all.
    const f = computeFrontier(
      [
        held(
          { id: 1, seq: 25, claim: { session: "x-t25", at: "2020-01-01T00:00:00.000Z" } },
          "x-t25",
        ),
      ],
      alive("x-t25"),
    );
    expect(f.inFlight).toHaveLength(1);
    expect(f.stale).toEqual([]);
  });

  test("blocked beats any Claim — the prerequisite still does not exist", () => {
    const tickets = [ticket({ id: 1, seq: 13 }), held({ id: 2, seq: 15, blockedBy: [1] }, "x-t15")];
    const f = computeFrontier(tickets, alive("x-t15"));
    expect(f.blocked).toHaveLength(1);
    expect(f.inFlight).toEqual([]);
  });

  test("buckets are ordered by board then seq", () => {
    const f = computeFrontier([
      ticket({ id: 1, seq: 9, workspace: "b" }),
      ticket({ id: 2, seq: 4, workspace: "a" }),
      ticket({ id: 3, seq: 2, workspace: "b" }),
    ]);
    expect(f.ready.map((t) => `${t.workspace}#${t.seq}`)).toEqual(["a#4", "b#2", "b#9"]);
  });
});

describe("blockerLabel", () => {
  test("bare within a board, qualified when the edge crosses one", () => {
    const from = ticket({ id: 1, seq: 4, workspace: "alpha" });
    expect(blockerLabel(ticket({ id: 2, seq: 3, workspace: "alpha" }), from)).toBe("#3");
    expect(blockerLabel(ticket({ id: 3, seq: 3, workspace: "platform" }), from)).toBe("platform#3");
  });
});

describe("reading the board", () => {
  test("readTasks feeds the frontier straight from SQLite, with no network involved", async () => {
    const core = createTicket({ workspace: "alpha", title: "core", now: AT });
    const tenant = createTicket({ workspace: "alpha", title: "tenant", now: AT });
    createTicket({ workspace: "beta", title: "elsewhere", now: AT });
    addDependency(tenant, core, { now: AT });

    const f = computeFrontier(readTasks(), { known: false }, { workspace: "alpha" });
    expect(f.ready.map((t) => t.title)).toEqual(["core"]);
    expect(f.blocked.map((b) => b.ticket.title)).toEqual(["tenant"]);

    updateTicket(core, { status: "done" }, { now: AT });
    const after = computeFrontier(readTasks(), { known: false }, { workspace: "alpha" });
    expect(after.ready.map((t) => t.title)).toEqual(["tenant"]);
  });

  test("readTasks honors the state filter", () => {
    createTicket({ workspace: "alpha", title: "open", now: AT });
    createTicket({ workspace: "alpha", title: "shipped", status: "done", now: AT });
    expect(readTasks({ state: "open" }).map((t) => t.title)).toEqual(["open"]);
    expect(readTasks({ state: "closed" }).map((t) => t.title)).toEqual(["shipped"]);
  });

  test("a Claim taken on the board shows up in the frontier", async () => {
    const t = createTicket({ workspace: "alpha", title: "one", now: AT });
    const { claimTicket } = await import("../src/core/claims.ts");
    await claimTicket("alpha", t.seq, "alpha-t1", { now: AT });
    const f = computeFrontier(readTasks(), alive("alpha-t1"));
    expect(f.inFlight.map((c) => c.claim.session)).toEqual(["alpha-t1"]);
    expect(requireTicket("alpha", t.seq).claim?.session).toBe("alpha-t1");
  });

  test("refreshing the liveness projection never throws, whatever the registry says", async () => {
    await refreshSessionProjection(AT);
  });
});
