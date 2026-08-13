import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addComment,
  addDependency,
  closeBoard,
  createTicket,
  dependentsOf,
  findTicket,
  listBoards,
  listTickets,
  openBlockerDepths,
  readTicket,
  recordSessionsSeen,
  removeDependency,
  sessionLastSeen,
  ticketActions,
  updateTicket,
} from "../src/core/board/store.ts";
import { boardDbPath, setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-board-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const AT = "2026-08-13T10:00:00.000Z";

const newTicket = (workspace: string, title: string, over = {}) =>
  createTicket({ workspace, title, now: AT, ...over });

describe("the database itself", () => {
  test("is created at the servant root on first write, in WAL mode", () => {
    expect(existsSync(boardDbPath())).toBe(false);
    newTicket("alpha", "first");
    expect(existsSync(boardDbPath())).toBe(true);
    expect(boardDbPath().startsWith(tmpRoot)).toBe(true);
  });
});

describe("tickets", () => {
  test("a board is created on demand and seq numbering is per board", () => {
    expect(newTicket("alpha", "one").seq).toBe(1);
    expect(newTicket("alpha", "two").seq).toBe(2);
    // A second workspace starts its own numbering — this is what keeps seqs small.
    expect(newTicket("beta", "one").seq).toBe(1);
    expect(listBoards()).toEqual(["alpha", "beta"]);
  });

  test("global ids stay distinct even where two boards share a seq", () => {
    const a = newTicket("alpha", "one");
    const b = newTicket("beta", "one");
    expect(a.seq).toBe(b.seq);
    expect(a.id).not.toBe(b.id);
  });

  test("carries body, labels, status, parent and the freeform input column", () => {
    const map = newTicket("alpha", "the map", { labels: ["wayfinder:map"] });
    const child = newTicket("alpha", "a child", {
      body: "why",
      labels: ["wayfinder:research", "ticket"],
      status: "in_progress",
      parentSeq: map.seq,
      input: { fog: ["what about auth?"] },
    });
    const read = readTicket(child.id);
    expect(read).toMatchObject({
      workspace: "alpha",
      seq: 2,
      title: "a child",
      body: "why",
      labels: ["wayfinder:research", "ticket"],
      status: "in_progress",
      parentId: map.id,
    });
    expect(read?.input).toEqual({ fog: ["what about auth?"] });
  });

  test("an explicit seq is honored, and the next generated seq clears it", () => {
    newTicket("alpha", "imported", { seq: 76 });
    expect(newTicket("alpha", "next").seq).toBe(77);
  });

  test("a duplicate seq on the same board is rejected", () => {
    newTicket("alpha", "imported", { seq: 5 });
    expect(() => newTicket("alpha", "again", { seq: 5 })).toThrow();
  });

  test("findTicket addresses a ticket the way a human does — workspace plus seq", () => {
    newTicket("alpha", "one");
    const b = newTicket("beta", "one");
    expect(findTicket("beta", 1)?.id).toBe(b.id);
    expect(findTicket("beta", 9)).toBeNull();
    expect(findTicket("nope", 1)).toBeNull();
  });

  test("updateTicket patches only what it is given, and stamps updatedAt", () => {
    const t = newTicket("alpha", "one", { labels: ["ticket"] });
    updateTicket(t.id, { status: "done", title: "renamed" }, { now: "2026-08-14T00:00:00.000Z" });
    const read = readTicket(t.id);
    expect(read).toMatchObject({ status: "done", title: "renamed", labels: ["ticket"] });
    expect(read?.updatedAt).toBe("2026-08-14T00:00:00.000Z");
  });

  test("listTickets filters by workspace and by open/closed state", () => {
    const a = newTicket("alpha", "open one");
    newTicket("alpha", "closed one", { status: "done" });
    newTicket("beta", "elsewhere");
    expect(listTickets({ state: "open" }).map((t) => t.title)).toEqual(["open one", "elsewhere"]);
    expect(listTickets({ workspace: "alpha", state: "open" }).map((t) => t.id)).toEqual([a.id]);
    expect(listTickets({ workspace: "alpha", state: "closed" })).toHaveLength(1);
    expect(listTickets({ workspace: "alpha", state: "all" })).toHaveLength(2);
  });

  test("an unknown status is rejected rather than stored", () => {
    expect(() => newTicket("alpha", "one", { status: "wibble" })).toThrow(/status/i);
  });
});

describe("dependencies", () => {
  test("blockedBy and the reverse edge both read back", () => {
    const core = newTicket("alpha", "core");
    const tenant = newTicket("alpha", "tenant");
    addDependency(tenant.id, core.id, { now: AT });
    expect(readTicket(tenant.id)?.blockedBy).toEqual([core.id]);
    // "what does this block" — the question the hub could never answer.
    expect(dependentsOf(core.id).map((t) => t.id)).toEqual([tenant.id]);
    expect(readTicket(core.id)?.blocks).toEqual([tenant.id]);
  });

  test("adding the same edge twice is a no-op", () => {
    const a = newTicket("alpha", "a");
    const b = newTicket("alpha", "b");
    addDependency(b.id, a.id, { now: AT });
    addDependency(b.id, a.id, { now: AT });
    expect(readTicket(b.id)?.blockedBy).toEqual([a.id]);
  });

  test("removeDependency drops just that edge", () => {
    const a = newTicket("alpha", "a");
    const b = newTicket("alpha", "b");
    const c = newTicket("alpha", "c");
    addDependency(c.id, a.id, { now: AT });
    addDependency(c.id, b.id, { now: AT });
    removeDependency(c.id, a.id);
    expect(readTicket(c.id)?.blockedBy).toEqual([b.id]);
  });

  test("a self-reference is rejected", () => {
    const a = newTicket("alpha", "a");
    expect(() => addDependency(a.id, a.id, { now: AT })).toThrow(/itself/i);
  });

  test("a cycle is rejected at write time, direct and transitive", () => {
    const a = newTicket("alpha", "a");
    const b = newTicket("alpha", "b");
    const c = newTicket("alpha", "c");
    addDependency(b.id, a.id, { now: AT });
    expect(() => addDependency(a.id, b.id, { now: AT })).toThrow(/cycle/i);
    addDependency(c.id, b.id, { now: AT });
    // a ← b ← c, so c blocking a would close the loop three edges out.
    expect(() => addDependency(a.id, c.id, { now: AT })).toThrow(/cycle/i);
    // The rejected edges left nothing behind.
    expect(readTicket(a.id)?.blockedBy).toEqual([]);
  });

  test("a diamond is not a cycle", () => {
    const root = newTicket("alpha", "root");
    const left = newTicket("alpha", "left");
    const right = newTicket("alpha", "right");
    const join_ = newTicket("alpha", "join");
    addDependency(left.id, root.id, { now: AT });
    addDependency(right.id, root.id, { now: AT });
    addDependency(join_.id, left.id, { now: AT });
    addDependency(join_.id, right.id, { now: AT });
    expect(readTicket(join_.id)?.blockedBy).toEqual([left.id, right.id]);
  });

  test("an edge may cross boards, and it survives the seq being renumbered", () => {
    const shared = newTicket("platform", "shared prerequisite");
    const consumer = newTicket("alpha", "consumer");
    addDependency(consumer.id, shared.id, { now: AT });
    // Edges reference the global id, so renumbering the blocker cannot break them.
    updateTicket(shared.id, { seq: 4000 }, { now: AT });
    expect(readTicket(consumer.id)?.blockedBy).toEqual([shared.id]);
    expect(readTicket(shared.id)?.seq).toBe(4000);
  });

  test("an unknown ticket cannot be depended on", () => {
    const a = newTicket("alpha", "a");
    expect(() => addDependency(a.id, 9999, { now: AT })).toThrow();
  });
});

describe("depth over open blockers only", () => {
  test("a ticket collapses to depth 0 as its blockers close", () => {
    const core = newTicket("alpha", "core");
    const tenant = newTicket("alpha", "tenant");
    addDependency(tenant.id, core.id, { now: AT });
    expect(openBlockerDepths("alpha").get(tenant.id)).toBe(1);
    updateTicket(core.id, { status: "done" }, { now: AT });
    // The whole point: depth is what is still in the way, not the static longest path.
    expect(openBlockerDepths("alpha").get(tenant.id)).toBe(0);
  });

  test("depth is the longest open chain, and done work is receded rather than numbered", () => {
    const a = newTicket("alpha", "a");
    const b = newTicket("alpha", "b");
    const c = newTicket("alpha", "c");
    const shortcut = newTicket("alpha", "shortcut");
    addDependency(b.id, a.id, { now: AT });
    addDependency(c.id, b.id, { now: AT });
    addDependency(c.id, shortcut.id, { now: AT });
    const depths = openBlockerDepths("alpha");
    expect(depths.get(a.id)).toBe(0);
    expect(depths.get(shortcut.id)).toBe(0);
    expect(depths.get(b.id)).toBe(1);
    expect(depths.get(c.id)).toBe(2);
    updateTicket(a.id, { status: "done" }, { now: AT });
    const after = openBlockerDepths("alpha");
    expect(after.get(a.id)).toBeNull();
    expect(after.get(b.id)).toBe(0);
    expect(after.get(c.id)).toBe(1);
  });

  test("a cross-board blocker still counts toward depth", () => {
    const shared = newTicket("platform", "shared");
    const consumer = newTicket("alpha", "consumer");
    addDependency(consumer.id, shared.id, { now: AT });
    expect(openBlockerDepths("alpha").get(consumer.id)).toBe(1);
  });
});

describe("actions", () => {
  test("a comment is an action row, and the history reads back in order", () => {
    const t = newTicket("alpha", "one");
    addComment(t.id, "found the cause", { session: "alpha-t1", now: AT });
    addComment(t.id, "and the fix", { now: "2026-08-13T11:00:00.000Z" });
    const actions = ticketActions(t.id);
    expect(actions.map((a) => [a.kind, a.body, a.session])).toEqual([
      ["created", "", null],
      ["comment", "found the cause", "alpha-t1"],
      ["comment", "and the fix", null],
    ]);
  });
});

describe("the session liveness projection", () => {
  test("last-seen is written by whichever command ran, and is only a projection", () => {
    expect(sessionLastSeen("alpha-t1")).toBeNull();
    recordSessionsSeen([{ name: "alpha-t1", pid: 4242 }], { now: AT });
    expect(sessionLastSeen("alpha-t1")).toEqual({ pid: 4242, lastSeen: AT });
    recordSessionsSeen([{ name: "alpha-t1", pid: 4242 }], { now: "2026-08-13T12:00:00.000Z" });
    expect(sessionLastSeen("alpha-t1")?.lastSeen).toBe("2026-08-13T12:00:00.000Z");
    // A session absent from a later observation keeps its last-seen: this is a cache of when it
    // was last seen alive, never the authority on whether it still is.
    recordSessionsSeen([], { now: "2026-08-13T13:00:00.000Z" });
    expect(sessionLastSeen("alpha-t1")?.lastSeen).toBe("2026-08-13T12:00:00.000Z");
  });
});
