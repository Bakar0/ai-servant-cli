import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDependency,
  closeBoard,
  createTicket,
  listTickets,
  recordSessionsSeen,
  updateClaim,
  updateTicket,
} from "../src/core/board/store.ts";
import type { Ticket } from "../src/core/board/store.ts";
import {
  buildBoardView,
  buildEverywhereView,
  dispatchCommand,
  formatAge,
  splitSections,
} from "../src/core/board/view.ts";
import { setRootOverride } from "../src/core/paths.ts";
import { computeFrontier } from "../src/core/tasks.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-board-view-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const byNumber = (a: number, b: number) => a - b;

const AT = "2026-08-14T10:00:00.000Z";
const NOW = "2026-08-14T12:00:00.000Z";
const WS = "kanban";

const file = (title: string, over: Record<string, unknown> = {}): Ticket =>
  createTicket({ workspace: WS, title, now: AT, ...over });

const blocks = (blocker: Ticket, waiting: Ticket) =>
  addDependency(waiting.id, blocker.id, { now: AT });

const view = (over: Parameters<typeof buildBoardView>[1] = {}) =>
  buildBoardView(WS, { now: NOW, ...over });

const card = (v: ReturnType<typeof view>, seq: number) => {
  const found = v.cards.find((c) => c.seq === seq);
  if (!found) throw new Error(`no card #${seq} in the view`);
  return found;
};

const seqsInColumn = (v: ReturnType<typeof view>, label: string) =>
  v.tree.find((c) => c.label === label)?.seqs ?? [];

describe("board columns", () => {
  test("blocked and ready are derived from open dependencies, not stored", () => {
    const store = file("store");
    const viewer = file("viewer");
    blocks(store, viewer);

    expect(card(view(), viewer.seq).column).toBe("blocked");
    expect(card(view(), store.seq).column).toBe("ready");

    updateTicket(store.id, { status: "done" }, { now: NOW });

    // Nothing was written to the viewer ticket; its column moved because the graph did.
    expect(card(view(), viewer.seq).column).toBe("ready");
    expect(card(view(), store.seq).column).toBe("done");
  });

  test("an explicit status wins over the derived pair", () => {
    const t = file("in flight");
    updateTicket(t.id, { status: "in_progress" }, { now: NOW });
    expect(card(view(), t.seq).column).toBe("in_progress");
    updateTicket(t.id, { status: "in_review" }, { now: NOW });
    expect(card(view(), t.seq).column).toBe("in_review");
  });

  test("every card lands in exactly one column", () => {
    const a = file("a");
    const b = file("b");
    blocks(a, b);
    updateTicket(a.id, { status: "in_progress" }, { now: NOW });
    const v = view();
    const counted = v.columns.flatMap((c) => c.seqs);
    expect(counted.toSorted(byNumber)).toEqual(v.cards.map((c) => c.seq).toSorted(byNumber));
    expect(new Set(counted).size).toBe(counted.length);
  });
});

describe("the card", () => {
  test("shows its holding session with a last-seen age", () => {
    const t = file("claimed");
    updateClaim(t.id, { session: `${WS}-t${t.seq}`, at: AT });
    recordSessionsSeen([{ name: `${WS}-t${t.seq}`, pid: 4242 }], {
      now: "2026-08-14T11:45:00.000Z",
    });

    const claim = card(view(), t.seq).claim;
    expect(claim?.session).toBe(`${WS}-t${t.seq}`);
    expect(claim?.age).toBe("15m ago");
  });

  test("falls back to the claim's own timestamp when the session was never seen", () => {
    const t = file("claimed");
    updateClaim(t.id, { session: "ghost", at: AT });
    const claim = card(view(), t.seq).claim;
    expect(claim?.lastSeen).toBeNull();
    expect(claim?.age).toBe("2h ago");
  });

  test("reads liveness from the frontier rather than repeating the PID check", () => {
    const alive = file("alive");
    const gone = file("gone");
    updateClaim(alive.id, { session: "s-alive", at: AT });
    updateClaim(gone.id, { session: "s-gone", at: AT });

    const known = view({ liveness: { known: true, liveSessions: ["s-alive"] } });
    expect(card(known, alive.seq).claim?.state).toBe("alive");
    expect(card(known, gone.seq).claim?.state).toBe("gone");

    // A host that cannot read the registry says so; it never downgrades a claim to free.
    const unknown = view();
    expect(card(unknown, alive.seq).claim?.state).toBe("unknown");
    expect(card(unknown, gone.seq).claim?.state).toBe("unknown");
    expect(unknown.livenessKnown).toBe(false);
  });

  test("lists its open blockers, and drops them as they close", () => {
    const one = file("one");
    const two = file("two");
    const waiting = file("waiting");
    blocks(one, waiting);
    blocks(two, waiting);
    expect(card(view(), waiting.seq).openBlockers.map((b) => b.label)).toEqual([
      `#${one.seq}`,
      `#${two.seq}`,
    ]);

    updateTicket(one.id, { status: "done" }, { now: NOW });
    expect(card(view(), waiting.seq).openBlockers.map((b) => b.label)).toEqual([`#${two.seq}`]);
  });

  test("qualifies a blocker that lives on another board, and draws no edge for it", () => {
    const elsewhere = createTicket({ workspace: "other", title: "cross-board", now: AT });
    const waiting = file("waiting");
    addDependency(waiting.id, elsewhere.id, { now: AT });

    const v = view();
    const blocker = card(v, waiting.seq).openBlockers[0];
    expect(blocker?.label).toBe(`other#${elsewhere.seq}`);
    expect(blocker?.onBoard).toBe(false);
    expect(v.edges).toEqual([]);
    // It is still a blocker: the card is blocked and the tree pushes it off the frontier.
    expect(card(v, waiting.seq).column).toBe("blocked");
    expect(card(v, waiting.seq).depth).toBe(1);
  });

  test("carries the wayfinder type its label declares, defaulting to task", () => {
    const research = file("does SSE survive sleep?", { labels: ["wayfinder:research"] });
    const plain = file("plain");
    expect(card(view(), research.seq).type).toBe("research");
    expect(card(view(), plain.seq).type).toBe("task");
  });
});

describe("the copy-dispatch command", () => {
  test("is offered on exactly the tickets the frontier reports as ready", () => {
    const done = file("done");
    const ready = file("ready");
    const claimed = file("claimed");
    const blocked = file("blocked");
    updateTicket(done.id, { status: "done" }, { now: NOW });
    updateClaim(claimed.id, { session: "someone", at: AT });
    blocks(ready, blocked);

    const v = view({ liveness: { known: true, liveSessions: ["someone"] } });
    const offered = v.cards.filter((c) => c.dispatch !== null).map((c) => c.seq);
    const frontierReady = computeFrontier(
      listTickets(),
      { known: true, liveSessions: ["someone"] },
      { workspace: WS },
    ).ready.map((t) => t.seq);

    expect(offered.toSorted(byNumber)).toEqual(frontierReady.toSorted(byNumber));
    expect(offered).toEqual([ready.seq]);
  });

  test("is suppressed on an unblocked in-review ticket only if the frontier says so", () => {
    // in_review is neither blocked nor claimed, so the frontier reports it ready and the button
    // appears. Faithful to the frontier by construction — the card never decides this itself.
    const t = file("under review");
    updateTicket(t.id, { status: "in_review" }, { now: NOW });
    const v = view({ liveness: { known: true, liveSessions: [] } });
    expect(card(v, t.seq).column).toBe("in_review");
    expect(card(v, t.seq).dispatch).not.toBeNull();
  });

  test("is suppressed on a stale claim too — reclaiming is a decision, not a copy", () => {
    const t = file("stale");
    updateClaim(t.id, { session: "ghost", at: AT });
    const v = view({ liveness: { known: true, liveSessions: [] } });
    expect(card(v, t.seq).claim?.state).toBe("gone");
    expect(card(v, t.seq).dispatch).toBeNull();
  });

  test("runs as-is: a real shell parses it into the two commands, quoting intact", async () => {
    // Every character a naively-built command line gets wrong, in one ordinary-looking title: a
    // double quote, a "$", a backtick and an apostrophe. So the copied string meets a real shell.
    const title = 'Viewer: the "board", $HOME, `date` and don\'t';
    const cmd = dispatchCommand("kanban", 77, title);
    const bin = join(tmpRoot, "bin");
    await mkdir(bin, { recursive: true });
    // Each argument then a unit separator, and a record separator per command, so an argument
    // containing a space or a newline still comes back as one field.
    await Bun.write(join(bin, "servant"), "#!/bin/sh\nprintf '%s\\037' \"$@\"\nprintf '\\036'\n");
    await chmod(join(bin, "servant"), 0o755);

    const run = Bun.spawnSync(["/bin/sh", "-c", cmd], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(run.exitCode).toBe(0);
    const [claimArgv, spawnArgv] = new TextDecoder()
      .decode(run.stdout)
      .split("\u001e")
      .filter(Boolean)
      .map((record) => record.split("\u001f").slice(0, -1));

    expect(claimArgv).toEqual(["claim", "77", "--ws", "kanban", "--session", "kanban-t77"]);
    expect(spawnArgv?.slice(0, 4)).toEqual(["spawn", "-w", "kanban", "--prompt"]);
    // The whole prompt survives as ONE argument, verbatim: nothing interpolated, nothing split.
    expect(spawnArgv).toHaveLength(5);
    expect(spawnArgv?.[4]).toContain(`"${title}"`);
    expect(spawnArgv?.[4]).toContain("/implement #77");
    expect(spawnArgv?.[4]).toContain("/code-review");
  });
});

describe("the tree", () => {
  test("depth counts only open blockers, so a card migrates left as they close", () => {
    const a = file("a");
    const b = file("b");
    const c = file("c");
    blocks(a, b);
    blocks(b, c);

    expect(card(view(), c.seq).depth).toBe(2);
    updateTicket(a.id, { status: "done" }, { now: NOW });
    expect(card(view(), c.seq).depth).toBe(1);
    updateTicket(b.id, { status: "done" }, { now: NOW });
    expect(card(view(), c.seq).depth).toBe(0);
    expect(seqsInColumn(view(), "Now")).toEqual([c.seq]);
  });

  test("done work recedes into its own column rather than taking a depth", () => {
    const a = file("a");
    const b = file("b");
    blocks(a, b);
    updateTicket(a.id, { status: "done" }, { now: NOW });

    const v = view();
    expect(card(v, a.seq).depth).toBeNull();
    expect(v.tree[0]).toMatchObject({ label: "Done", depth: null, seqs: [a.seq] });
    expect(seqsInColumn(v, "Now")).toEqual([b.seq]);
  });

  test("the first column is exactly the frontier's unblocked set, and the rest exactly its blocked set", () => {
    const root = file("root");
    const mid = file("mid");
    const leaf = file("leaf");
    const loose = file("loose");
    const held = file("held");
    const shipped = file("shipped");
    blocks(root, mid);
    blocks(mid, leaf);
    updateClaim(held.id, { session: "s-held", at: AT });
    updateTicket(shipped.id, { status: "done" }, { now: NOW });

    const liveness = { known: true, liveSessions: ["s-held"] } as const;
    const v = view({ liveness });
    const frontier = computeFrontier(listTickets(), liveness, { workspace: WS });

    // Depth 0 is every open ticket with nothing left in its way: the ready ones, plus the ones a
    // session is already carrying. `ready` is the subset that is also free.
    const unblocked = [
      ...frontier.ready.map((t) => t.seq),
      ...frontier.stale.map((c) => c.ticket.seq),
      ...frontier.inFlight.map((c) => c.ticket.seq),
    ].toSorted(byNumber);
    expect(seqsInColumn(v, "Now").toSorted(byNumber)).toEqual(unblocked);
    expect(frontier.ready.every((t) => seqsInColumn(v, "Now").includes(t.seq))).toBe(true);

    const beyond = v.tree
      .filter((c) => typeof c.depth === "number" && c.depth > 0)
      .flatMap((c) => c.seqs)
      .toSorted(byNumber);
    expect(beyond).toEqual(frontier.blocked.map((b) => b.ticket.seq).toSorted(byNumber));
    expect(beyond).toEqual([mid.seq, leaf.seq].toSorted(byNumber));
    expect(loose.seq).toBeGreaterThan(0);
  });

  test("labels depths past Later by number rather than inventing a word", () => {
    let previous = file("d0");
    for (let i = 1; i <= 5; i++) {
      const next = file(`d${i}`);
      blocks(previous, next);
      previous = next;
    }
    expect(view().tree.map((c) => c.label)).toEqual([
      "Done",
      "Now",
      "Next",
      "Then",
      "Later",
      "+4",
      "+5",
    ]);
  });
});

describe("edges and fans", () => {
  test("only a blocker feeding 2+ tickets gets a colour; single edges stay neutral", () => {
    const fan = file("fan");
    const kidA = file("kid a");
    const kidB = file("kid b");
    const lone = file("lone");
    const only = file("only child");
    blocks(fan, kidA);
    blocks(fan, kidB);
    blocks(lone, only);

    const v = view();
    expect(v.fans).toEqual([{ seq: fan.seq, color: expect.any(String), count: 2 }]);
    const fanColor = v.fans[0]?.color;
    expect(v.edges.filter((e) => e.from === fan.seq).every((e) => e.color === fanColor)).toBe(true);
    expect(v.edges.filter((e) => e.from === fan.seq).every((e) => e.fan)).toBe(true);

    const single = v.edges.find((e) => e.from === lone.seq);
    expect(single?.fan).toBe(false);
    expect(single?.color).not.toBe(fanColor);
    // Colour means "this is a group" — the lone blocker gets no swatch in the legend.
    expect(v.fans.map((f) => f.seq)).not.toContain(lone.seq);
  });

  test("a card takes the stripe of the edge that reaches it", () => {
    const fan = file("fan");
    const kidA = file("kid a");
    const kidB = file("kid b");
    blocks(fan, kidA);
    blocks(fan, kidB);

    const v = view();
    const color = v.fans[0]?.color;
    expect(card(v, fan.seq).fanColor).toBe(color as string);
    expect(card(v, kidA.seq).stripe).toBe(color as string);
    expect(card(v, kidB.seq).stripe).toBe(color as string);
  });

  test("cards in a column are ordered by their blocker, keeping a fan's children adjacent", () => {
    const fan = file("fan");
    const other = file("other");
    // Interleaved on purpose: by seq these would alternate between the two blockers.
    const fanKid1 = file("fan kid 1");
    const otherKid1 = file("other kid 1");
    const fanKid2 = file("fan kid 2");
    const otherKid2 = file("other kid 2");
    for (const kid of [fanKid1, fanKid2]) blocks(fan, kid);
    for (const kid of [otherKid1, otherKid2]) blocks(other, kid);

    const next = seqsInColumn(view(), "Next");
    const positions = [fanKid1, fanKid2].map((t) => next.indexOf(t.seq));
    expect(Math.abs((positions[1] as number) - (positions[0] as number))).toBe(1);
  });
});

describe("chains", () => {
  test("reach every ancestor and descendant, and exclude the card itself", () => {
    const a = file("a");
    const b = file("b");
    const c = file("c");
    const unrelated = file("unrelated");
    blocks(a, b);
    blocks(b, c);

    const v = view();
    expect(v.chains[String(b.seq)]).toEqual([a.seq, c.seq].toSorted(byNumber));
    expect(v.chains[String(a.seq)]).toEqual([b.seq, c.seq].toSorted(byNumber));
    expect(v.chains[String(unrelated.seq)]).toEqual([]);
  });

  test("survive a diamond without looping or repeating a node", () => {
    const top = file("top");
    const left = file("left");
    const right = file("right");
    const bottom = file("bottom");
    blocks(top, left);
    blocks(top, right);
    blocks(left, bottom);
    blocks(right, bottom);

    expect(view().chains[String(top.seq)]).toEqual(
      [left.seq, right.seq, bottom.seq].toSorted((a, b) => a - b),
    );
  });
});

describe("the map's prose", () => {
  const MAP_BODY = `## Destination

One board that servant owns end to end.

## Notes

Consult the board store before writing viewer code.

## Decisions so far

<!-- the index -->

- [Claims live on the board](http://x) — assignment plus an action log
- [Knowledge moves to the servant root](http://y) — a local git repo, no remote

## Not yet specified

- Does the copied dispatch command need to name the workspace?
- Do cross-board dependencies belong on the depth axis?

## Out of scope

Live agent-activity streaming · forking agent-kanban · auth and remote access
`;

  test("is read off the wayfinder map ticket and frames the canvas", () => {
    file("Replace the GitHub tracker with a local board", {
      labels: ["wayfinder:map"],
      body: MAP_BODY,
    });
    const map = view().map;
    expect(map?.title).toBe("Replace the GitHub tracker with a local board");
    expect(map?.destination).toBe("One board that servant owns end to end.");
    expect(map?.outOfScope).toEqual([
      "Live agent-activity streaming · forking agent-kanban · auth and remote access",
    ]);
    expect(map?.fog).toHaveLength(2);
    expect(map?.fog[0]).toContain("dispatch command");
    expect(map?.decisions).toHaveLength(2);
  });

  // The section a real map writes as a list, which is the case that pushed the tickets off the
  // first screen when it was flattened into one paragraph.
  test("keeps an out-of-scope list a list, rather than joining it into a paragraph", () => {
    file("map", {
      labels: ["wayfinder:map"],
      body: "## Out of scope\n\n- **Auth** — single user.\n- Remote access.\n",
    });
    expect(view().map?.outOfScope).toEqual(["**Auth** — single user.", "Remote access."]);
  });

  test("keeps the fog visible when it was written as a paragraph rather than a list", () => {
    file("map", {
      labels: ["wayfinder:map"],
      body: "## Not yet specified\n\nWhatever happens to a claim mid-write.\n",
    });
    expect(view().map?.fog).toEqual(["Whatever happens to a claim mid-write."]);
  });

  test("is absent, not fatal, on a board that was never charted", () => {
    file("just a ticket");
    expect(view().map).toBeNull();
  });

  test("splitSections tolerates a missing section instead of failing the whole frame", () => {
    const sections = splitSections("## Destination\n\nGo there.\n");
    expect(sections.get("destination")).toBe("Go there.");
    expect(sections.get("out of scope")).toBeUndefined();
  });
});

describe("formatAge", () => {
  test("answers at the coarseness the question has", () => {
    const base = "2026-08-14T12:00:00.000Z";
    expect(formatAge("2026-08-14T11:59:31.000Z", base)).toBe("just now");
    expect(formatAge("2026-08-14T11:52:00.000Z", base)).toBe("8m ago");
    expect(formatAge("2026-08-14T09:00:00.000Z", base)).toBe("3h ago");
    expect(formatAge("2026-08-10T12:00:00.000Z", base)).toBe("4d ago");
    expect(formatAge("not a date", base)).toBeNull();
  });
});

describe("every board's frontier", () => {
  const elsewhere = (title: string, over: Record<string, unknown> = {}): Ticket =>
    createTicket({ workspace: "other", title, now: AT, ...over });

  const everywhere = (over: Parameters<typeof buildEverywhereView>[0] = {}) =>
    buildEverywhereView({ now: NOW, ...over });

  test("carries what is dispatchable on any board, and nothing else", () => {
    const ready = file("ready here");
    const blocker = file("blocker");
    const blocked = file("blocked here");
    blocks(blocker, blocked);
    const held = file("held here");
    updateClaim(held.id, { session: "s-alive", at: AT });
    const abandoned = file("abandoned here");
    updateClaim(abandoned.id, { session: "s-gone", at: AT });
    const there = elsewhere("ready there");

    const v = everywhere({ liveness: { known: true, liveSessions: ["s-alive"] } });

    expect(v.boards.map((b) => b.workspace)).toEqual(["kanban", "other"]);
    expect(v.boards[0]?.cards.map((c) => c.title).toSorted()).toEqual([
      "abandoned here",
      "blocker",
      "ready here",
    ]);
    expect(v.boards[1]?.cards.map((c) => c.title)).toEqual([there.title]);
    // Blocked and in-flight work stays on its own board.
    expect(v.boards.flatMap((b) => b.cards).map((c) => c.seq)).not.toContain(blocked.seq);
    expect(v.boards.flatMap((b) => b.cards).map((c) => c.seq)).not.toContain(held.seq);
    expect(v.ready).toBe(3);
    expect(v.reclaimable).toBe(1);
    expect(ready.seq).toBeGreaterThan(0);
  });

  test("agrees with the frontier the CLI reports, because it is the same computation", () => {
    const one = file("one");
    const two = elsewhere("two");
    const waiting = elsewhere("waiting");
    blocks(one, waiting);
    updateClaim(two.id, { session: "s-gone", at: AT });
    const liveness = { known: true, liveSessions: [] as string[] };

    const frontier = computeFrontier(listTickets(), liveness);
    const listed = everywhere({ liveness })
      .boards.flatMap((b) => b.cards.map((c) => `${c.workspace}#${c.seq}`))
      .toSorted();

    expect(listed).toEqual(
      [
        ...frontier.ready.map((t) => `${t.workspace}#${t.seq}`),
        ...frontier.stale.map((c) => `${c.ticket.workspace}#${c.ticket.seq}`),
      ].toSorted(),
    );
  });

  test("a blocker on another board still blocks, so its dependent is not offered", () => {
    const blocker = file("blocker here");
    const waiting = elsewhere("waiting there");
    blocks(blocker, waiting);

    const v = everywhere({ liveness: { known: true, liveSessions: [] } });

    expect(v.boards.map((b) => b.workspace)).toEqual(["kanban"]);
    expect(v.boards[0]?.cards.map((c) => c.seq)).toEqual([blocker.seq]);
  });

  test("marks a dead session's ticket as reclaimable, and still offers the command", () => {
    const t = file("abandoned");
    updateClaim(t.id, { session: "s-gone", at: AT });

    const v = everywhere({ liveness: { known: true, liveSessions: [] } });
    const listed = v.boards[0]?.cards[0];

    expect(listed?.staleClaim?.session).toBe("s-gone");
    expect(listed?.staleClaim?.state).toBe("gone");
    // The command reclaims as it spawns, so a dead Claim is not a reason to withhold it.
    expect(listed?.dispatch).toBe(dispatchCommand(WS, t.seq, t.title));
  });
});
