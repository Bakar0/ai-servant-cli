// The shipped page, rendered and driven without a browser.
//
// happy-dom runs the real `board.html` — the asset the binary serves, not a re-implementation of it
// — so the tree, the rail, the copy button and the hover/lock interaction are asserted against the
// same markup and the same inline script a user gets.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DATA_SLOT } from "../src/core/board/server.ts";
import { BOARD_TEMPLATE } from "../src/core/board/board-template.ts";
import {
  addDependency,
  closeBoard,
  createTicket,
  updateClaim,
  updateTicket,
} from "../src/core/board/store.ts";
import { buildBoardView, buildEverywhereView, dispatchCommand } from "../src/core/board/view.ts";
import type { BoardView, EverywhereView } from "../src/core/board/view.ts";
import { fillDataSlot } from "../src/core/html-artifact.ts";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
/** One window per test, so a page's listeners never outlive the page that registered them. */
let win: Window;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-board-page-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  await win?.happyDOM.close();
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const AT = "2026-08-14T10:00:00.000Z";
const NOW = "2026-08-14T12:00:00.000Z";
const WS = "kanban";

const file = (title: string, over: Record<string, unknown> = {}) =>
  createTicket({ workspace: WS, title, now: AT, ...over });

/** Load the real page with a payload, and run its script. */
async function mount(payload: {
  view: BoardView | null;
  everywhere?: EverywhereView | null;
  focus?: number | null;
  /** Board names, in the order the server would send them — most recently touched first. */
  boards?: string[];
}): Promise<void> {
  const html = fillDataSlot(BOARD_TEMPLATE, BOARD_DATA_SLOT, {
    boards: (payload.boards ?? [WS]).map((workspace) => ({
      workspace,
      open: 1,
      lastActivity: AT,
    })),
    workspace: payload.view?.workspace ?? null,
    view: payload.view,
    everywhere: payload.everywhere ?? null,
    focus: payload.focus ?? null,
    // No stream in these tests: the page must render from what it was served.
    eventsPath: null,
  });
  win = new Window({
    url: "http://127.0.0.1:7787/",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  } as ConstructorParameters<typeof Window>[0]);
  seedIntrinsics(win);
  win.document.write(html);
  await win.happyDOM.waitUntilComplete();
}

/**
 * Harness concession, not a fact about browsers: happy-dom evaluates a page script inside a
 * `node:vm` context, and under Bun that context reaches the DOM globals but not the language's own
 * — a page calling `String()` or `JSON.parse()` dies on "String is undefined". Handing the window
 * the host realm's intrinsics restores what every real browser already provides.
 */
function seedIntrinsics(target: Window): void {
  const host = globalThis as unknown as Record<string, unknown>;
  const into = target as unknown as Record<string, unknown>;
  for (const name of [
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "Function",
    "Set",
    "Map",
    "JSON",
    "Math",
    "Date",
    "RegExp",
    "Error",
    "Promise",
    "encodeURIComponent",
    "decodeURIComponent",
    "parseInt",
    "parseFloat",
    "isNaN",
  ]) {
    if (into[name] === undefined) into[name] = host[name];
  }
}

const view = () => buildBoardView(WS, { now: NOW });

// happy-dom's own element types, so the tests need no DOM lib in tsconfig.
type PageElement = NonNullable<ReturnType<Window["document"]["querySelector"]>>;

const doc = () => win.document;
const $ = (selector: string) => doc().querySelector(selector);
const $$ = (selector: string) => [...doc().querySelectorAll(selector)];
const body = () => doc().body;

const cardEl = (seq: number) => $(`.cols .card[data-seq="${seq}"]`) as PageElement;

const columnTitles = () =>
  $$(".cols .col > h3").map((h) => (h.textContent ?? "").split(" ·")[0]?.trim());

const seqsUnder = (label: string) => {
  const col = $$(".cols .col").find((c) =>
    (c.querySelector("h3")?.textContent ?? "").startsWith(label),
  );
  return [...(col?.querySelectorAll(".card") ?? [])].map((c) => Number(c.getAttribute("data-seq")));
};

const hover = (el: PageElement) =>
  el.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));
const click = (el: PageElement) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const press = (key: string) =>
  doc().dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }));

describe("the page", () => {
  test("renders the tree, the rail and the map's prose frame", async () => {
    file("Replace the tracker", {
      labels: ["wayfinder:map"],
      body: [
        "## Destination",
        "",
        "One board servant owns end to end.",
        "",
        "## Decisions so far",
        "",
        "- Claims live on the board",
        "",
        "## Not yet specified",
        "",
        "- Does dispatch need the workspace?",
        "",
        "## Out of scope",
        "",
        "Auth and remote access.",
      ].join("\n"),
    });
    const blocker = file("blocker");
    const waiting = file("waiting");
    addDependency(waiting.id, blocker.id, { now: AT });

    await mount({ view: view() });

    expect($(".frame h1")?.textContent).toBe("Replace the tracker");
    expect($(".frame .dest")?.textContent).toContain("One board servant owns end to end.");
    expect($(".frame .oos")?.textContent).toContain("Auth and remote access.");
    // Fog renders, and as fog — inside the dashed box, not as a tree column.
    expect($(".fogbox")?.textContent).toContain("Does dispatch need the workspace?");
    expect($$(".cols .fogbox")).toHaveLength(0);
    expect($("details.dec")?.textContent).toContain("Claims live on the board");

    expect(columnTitles()).toEqual(["Done", "Now", "Next"]);
    expect(seqsUnder("Next")).toEqual([waiting.seq]);
    expect($$(".rail .grp > h4").map((h) => h.textContent?.replace(/\d+$/, ""))).toEqual([
      "Blocked",
      "Ready",
      "In progress",
      "In review",
      "Done",
    ]);
  });

  test("a card shows its column, its holding session with an age, and its open blockers", async () => {
    const blocker = file("blocker");
    const waiting = file("waiting");
    addDependency(waiting.id, blocker.id, { now: AT });
    updateClaim(blocker.id, { session: "kanban-t1", at: "2026-08-14T11:30:00.000Z" });

    await mount({ view: view() });

    const held = cardEl(blocker.seq);
    expect(held.querySelector(".chip.claim")?.textContent).toBe("kanban-t1 · 30m ago");
    const blocked = cardEl(waiting.seq);
    expect(blocked.querySelector(".chip.blocked")?.textContent).toBe("Blocked");
    expect(blocked.querySelector(".chip.plain")?.textContent).toBe(`← #${blocker.seq}`);
  });

  test("offers the copy button only where a dispatch would be safe", async () => {
    const ready = file("ready");
    const claimed = file("claimed");
    const blocked = file("blocked");
    const done = file("done");
    addDependency(blocked.id, ready.id, { now: AT });
    updateClaim(claimed.id, { session: "someone", at: AT });
    updateTicket(done.id, { status: "done" }, { now: NOW });

    await mount({ view: view() });

    expect(cardEl(ready.seq).querySelector(".copy")).not.toBeNull();
    expect(cardEl(ready.seq).querySelector(".copy")?.getAttribute("data-dispatch")).toContain(
      `servant claim ${ready.seq} --ws kanban`,
    );
    expect(cardEl(claimed.seq).querySelector(".copy")).toBeNull();
    expect(cardEl(blocked.seq).querySelector(".copy")).toBeNull();
    expect(cardEl(done.seq).querySelector(".copy")).toBeNull();
  });

  // A real map's Out of scope section runs to 5,600 characters of Markdown bullets. Flattened into
  // one paragraph it filled the screen and pushed the first column of tickets below the fold, so it
  // stays a list, and one that is folded away until asked for.
  test("folds a long out-of-scope section away, as a list rather than a wall", async () => {
    file("Charted", {
      labels: ["wayfinder:map"],
      body: "## Out of scope\n\n- **Auth** — single user.\n- Remote access.\n- Streaming.\n",
    });

    await mount({ view: view() });

    const oos = $(".frame .oos") as PageElement;
    expect(oos.tagName.toLowerCase()).toBe("details");
    expect(oos.hasAttribute("open")).toBe(false);
    expect(oos.querySelector("summary")?.textContent).toBe("Out of scope — 3 exclusions");
    expect([...oos.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Auth — single user.",
      "Remote access.",
      "Streaming.",
    ]);
  });

  test("renders the map's inline Markdown instead of showing its syntax", async () => {
    file("Charted", {
      labels: ["wayfinder:map"],
      body: '## Destination\n\n**Bold** and `code` and *emphasis*, but <b>not</b> "markup".\n',
    });

    await mount({ view: view() });

    const dest = $(".frame .dest") as PageElement;
    expect(dest.querySelector("b")?.textContent).toBe("Bold");
    expect(dest.querySelector("code")?.textContent).toBe("code");
    expect(dest.querySelector("i")?.textContent).toBe("emphasis");
    // The map's own `<b>` is text: escaping runs before the Markdown, so the only tags on the page
    // are the ones the renderer put there.
    expect(dest.querySelectorAll("b")).toHaveLength(1);
    expect(dest.textContent).toContain('<b>not</b> "markup"');
  });

  test("escapes a ticket title rather than letting it become markup", async () => {
    const nasty = file('<img src=x onerror="boom"> & "quoted"');
    await mount({ view: view() });
    const card = cardEl(nasty.seq);
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".title")?.textContent).toBe('<img src=x onerror="boom"> & "quoted"');
  });

  // Every slot at once, because the page's guarantee is that escaping is the default rather than a
  // habit: text, an attribute, the rail and the map's prose all go through the same `html`, and a
  // slot added later the same way inherits it. The payload closes an attribute before opening a
  // tag, so it escapes through either kind of hole.
  test("escapes text, attributes and the map's prose alike", async () => {
    const payload = '"><img src=x onerror="boom">';
    const nasty = file(payload, {
      labels: ["wayfinder:map"],
      body: `## Destination\n\n${payload}\n\n## Out of scope\n\n${payload}`,
    });
    updateClaim(nasty.id, { session: payload, at: AT });

    await mount({ view: view() });

    expect($$("img")).toHaveLength(0);
    expect($(".frame .dest")?.textContent).toContain(payload);
    expect($(".frame .oos")?.textContent).toContain(payload);
    expect($(`.rail .item[data-seq="${nasty.seq}"] .t`)?.textContent).toBe(payload);
    const claimChip = cardEl(nasty.seq).querySelector(".chip.claim") as PageElement;
    expect(claimChip.textContent).toContain(payload);
    expect(claimChip.getAttribute("class")).toBe("chip claim unknown");
  });
});

describe("tracing a chain", () => {
  const chainBoard = () => {
    const root = file("root");
    const mid = file("mid");
    const leaf = file("leaf");
    const loose = file("unrelated");
    addDependency(mid.id, root.id, { now: AT });
    addDependency(leaf.id, mid.id, { now: AT });
    return { root, mid, leaf, loose };
  };

  test("hover lights the whole ancestor and descendant chain and dims the rest", async () => {
    const { root, mid, leaf, loose } = chainBoard();
    await mount({ view: view() });

    hover(cardEl(mid.seq));
    expect(body().classList.contains("hov")).toBe(true);
    expect(cardEl(mid.seq).classList.contains("self")).toBe(true);
    expect(cardEl(root.seq).classList.contains("lit")).toBe(true);
    expect(cardEl(leaf.seq).classList.contains("lit")).toBe(true);
    expect(cardEl(loose.seq).classList.contains("lit")).toBe(false);

    // The rail is part of the same trace — the same ticket, a different lens.
    const railItem = $(`.rail .item[data-seq="${root.seq}"]`) as PageElement;
    expect(railItem.classList.contains("lit")).toBe(true);
  });

  test("hover releases on its own; a click locks it so it survives the pointer moving away", async () => {
    const { root, mid, loose } = chainBoard();
    await mount({ view: view() });

    hover(cardEl(mid.seq));
    hover(body());
    expect(body().classList.contains("hov")).toBe(false);

    click(cardEl(mid.seq));
    expect(body().classList.contains("lock")).toBe(true);
    // The whole point of the lock: moving the pointer must not drop the trace.
    hover(cardEl(loose.seq));
    hover(body());
    expect(body().classList.contains("lock")).toBe(true);
    expect(cardEl(root.seq).classList.contains("lit")).toBe(true);
    expect($("#hint")?.textContent).toContain(`chain locked on #${mid.seq}`);
  });

  test("Escape releases the lock, and so does a click away", async () => {
    const { mid } = chainBoard();
    await mount({ view: view() });

    click(cardEl(mid.seq));
    press("Escape");
    expect(body().classList.contains("lock")).toBe(false);
    expect(body().classList.contains("hov")).toBe(false);

    click(cardEl(mid.seq));
    expect(body().classList.contains("lock")).toBe(true);
    click(body());
    expect(body().classList.contains("lock")).toBe(false);
  });

  test("copying a dispatch does not toggle the lock out from under the click", async () => {
    const ready = file("ready");
    await mount({ view: view() });
    click(cardEl(ready.seq).querySelector(".copy") as PageElement);
    expect(body().classList.contains("lock")).toBe(false);
  });

  test("a deep link arrives with that ticket's chain already locked", async () => {
    const { root, mid } = chainBoard();
    await mount({ view: view(), focus: mid.seq });
    expect(body().classList.contains("lock")).toBe(true);
    expect(cardEl(mid.seq).classList.contains("self")).toBe(true);
    expect(cardEl(root.seq).classList.contains("lit")).toBe(true);
  });

  test("a deep link to a ticket that is no longer there dims nothing", async () => {
    // A ticket URL outlives the ticket — renumbered, or on a board it was never on.
    chainBoard();
    await mount({ view: view(), focus: 9999 });
    expect(body().classList.contains("lock")).toBe(false);
    expect(body().classList.contains("hov")).toBe(false);
    expect($("#hint")?.textContent).toBe("");
  });
});

describe("a pushed change", () => {
  test("moves a card toward the frontier with no reload, keeping the traced chain", async () => {
    const blocker = file("blocker");
    const waiting = file("waiting");
    addDependency(waiting.id, blocker.id, { now: AT });
    await mount({ view: view(), focus: waiting.seq });

    expect(seqsUnder("Next")).toEqual([waiting.seq]);
    expect(body().classList.contains("lock")).toBe(true);

    updateTicket(blocker.id, { status: "done" }, { now: NOW });
    (win as unknown as { applyBoardView: (v: BoardView) => void }).applyBoardView(view());

    expect(seqsUnder("Now")).toEqual([waiting.seq]);
    expect(seqsUnder("Done")).toEqual([blocker.seq]);
    // Its last blocker closed, so it became dispatchable — the button appears with it.
    expect(cardEl(waiting.seq).querySelector(".copy")).not.toBeNull();
    expect(body().classList.contains("lock")).toBe(true);
    expect(cardEl(waiting.seq).classList.contains("self")).toBe(true);
  });

  test("drops a lock on a ticket the update removed, rather than tracing a ghost", async () => {
    const gone = file("gone");
    file("stays");
    await mount({ view: view(), focus: gone.seq });
    expect(body().classList.contains("lock")).toBe(true);

    const without = view();
    without.cards = without.cards.filter((c) => c.seq !== gone.seq);
    without.tree = without.tree.map((col) => ({
      ...col,
      seqs: col.seqs.filter((s) => s !== gone.seq),
    }));
    without.columns = without.columns.map((col) => ({
      ...col,
      seqs: col.seqs.filter((s) => s !== gone.seq),
    }));
    (win as unknown as { applyBoardView: (v: BoardView) => void }).applyBoardView(without);

    expect(body().classList.contains("lock")).toBe(false);
  });
});

describe("the picker", () => {
  test("names every board when there is no single obvious one", async () => {
    await mount({ view: null, boards: ["alpha", "beta"] });
    expect($$(".picker a").map((a) => a.getAttribute("href"))).toEqual(["/w/alpha", "/w/beta"]);
  });

  test("says so, rather than showing an empty board, when nothing has been filed", async () => {
    await mount({ view: null, boards: [] });
    expect($(".picker h1")?.textContent).toBe("No boards yet");
  });
});

// Workspaces run in parallel, so the board you want is often not the board you are on.
describe("switching boards", () => {
  const otherBoard = () => {
    createTicket({ workspace: "other", title: "elsewhere", now: AT });
    return buildBoardView("other", { now: NOW });
  };

  /**
   * Answer `/api/w/<ws>` with this view, and record both what was asked for and what the page
   * pushed onto the history. The pushes are what the assertions read: happy-dom follows an anchor's
   * href whether or not the click was default-prevented, so `location` here says nothing about
   * whether the page navigated. That half is asserted in a real browser instead.
   */
  const serve = (next: BoardView | null): { asked: string[]; pushed: string[] } => {
    const asked: string[] = [];
    const pushed: string[] = [];
    (win as unknown as { fetch: (url: string) => Promise<unknown> }).fetch = (url: string) => {
      asked.push(url);
      return Promise.resolve({
        ok: next !== null,
        status: next === null ? 404 : 200,
        json: () => Promise.resolve(next),
      });
    };
    win.history.pushState = ((_state: unknown, _title: string, url: string) => {
      pushed.push(url);
    }) as typeof win.history.pushState;
    return { asked, pushed };
  };

  const settle = () => win.happyDOM.waitUntilComplete();

  test("stays shut by default when there is only one board", async () => {
    file("only");
    await mount({ view: view() });
    expect(body().classList.contains("drawer")).toBe(false);
    // Still reachable — the toggle is always there, because a second board can appear at any time.
    expect($("#drawertoggle")).not.toBeNull();
  });

  test("opens by default when there is a choice to make", async () => {
    file("here");
    await mount({ view: view(), boards: ["kanban", "other"] });
    expect(body().classList.contains("drawer")).toBe(true);
  });

  test("names every board and marks the one on screen", async () => {
    file("here");
    await mount({ view: view(), boards: ["kanban", "other"] });
    expect($$("#drawer .dlist .board").map((a) => a.getAttribute("data-board"))).toEqual([
      "kanban",
      "other",
    ]);
    // Real links, so a board can still be middle-clicked into its own tab or bookmarked.
    expect($$("#drawer .dlist .board").map((a) => a.getAttribute("href"))).toEqual([
      "/w/kanban",
      "/w/other",
    ]);
    expect($("#drawer .board.on")?.getAttribute("data-board")).toBe("kanban");
    // Every board's frontier is its own entry, outside the filtered list.
    expect($("#drawer .every")?.getAttribute("href")).toBe("/everywhere");
  });

  test("switches the whole page in place, and the URL follows", async () => {
    file("here");
    const next = otherBoard();
    await mount({ view: view(), boards: ["kanban", "other"] });
    const { asked, pushed } = serve(next);

    click($('#drawer .board[data-board="other"]') as PageElement);
    await settle();

    expect(asked).toEqual(["/api/w/other"]);
    expect($("#drawer .board.on")?.getAttribute("data-board")).toBe("other");
    expect($$(".rail .item .t").map((t) => t.textContent)).toEqual(["elsewhere"]);
    expect(pushed).toEqual(["/w/other"]);
  });

  test("drops a lock rather than carrying its number onto another board", async () => {
    const here = file("here");
    const next = otherBoard();
    await mount({ view: view(), focus: here.seq, boards: ["kanban", "other"] });
    expect(body().classList.contains("lock")).toBe(true);
    serve(next);

    click($('#drawer .board[data-board="other"]') as PageElement);
    await settle();

    expect(body().classList.contains("lock")).toBe(false);
  });

  test("says so and stays put when the other board cannot be read", async () => {
    file("here");
    await mount({ view: view(), boards: ["kanban", "other"] });
    const { pushed } = serve(null);

    click($('#drawer .board[data-board="other"]') as PageElement);
    await settle();

    expect($("#status")?.textContent).toBe("could not load other");
    expect($("#drawer .board.on")?.getAttribute("data-board")).toBe("kanban");
    // Nothing was pushed, so the back button does not lead to a board that never loaded.
    expect(pushed).toEqual([]);
  });
});

describe("wiring the tree", () => {
  /**
   * happy-dom lays nothing out, so geometry is supplied: one synthetic column grid, keyed off where
   * each card actually sits in the rendered DOM. That is enough to assert the *routing rule*, which
   * is the part that was wrong — a same-column edge drawn as an ordinary left-to-right bezier loops
   * back across both cards and reads as a connection to whatever it crosses.
   */
  const GUTTER = 34;
  const COL_WIDTH = 300;
  const GAP = 28;
  const ROW_HEIGHT = 90;

  function stubGeometry(): void {
    const host = () => win.document.getElementById("cols");
    const rect = (left: number, top: number, right: number, bottom: number) => ({
      left,
      top,
      right,
      bottom,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    });
    const proto = (win as unknown as { Element: { prototype: Record<string, unknown> } }).Element
      .prototype;
    proto.getBoundingClientRect = function (this: PageElement) {
      const cols = host();
      if (!cols) return rect(0, 0, 0, 0);
      if (this === (cols as unknown as PageElement)) return rect(0, 0, 1200, 800);
      if (!this.classList.contains("card")) return rect(0, 0, 0, 0);
      const columns = [...cols.querySelectorAll(".col")];
      const column = columns.findIndex((c) => c.contains(this as never));
      const row = [...(columns[column]?.querySelectorAll(".card") ?? [])].indexOf(this as never);
      const left = GUTTER + column * (COL_WIDTH + GAP);
      const top = row * ROW_HEIGHT;
      return rect(left, top, left + COL_WIDTH, top + 70);
    };
  }

  /** Start x, first control x, and end x of each rendered wire. */
  const wires = () =>
    [...doc().querySelectorAll("#wires path")].map((p) => {
      const d = p.getAttribute("d") ?? "";
      const start = Number(/^M([\d.-]+),/.exec(d)?.[1]);
      const control = Number(/ C([\d.-]+),/.exec(d)?.[1]);
      const end = Number(d.slice(d.lastIndexOf(" ") + 1).split(",")[0]);
      return { start, control, end };
    });

  const redraw = () =>
    (win as unknown as { applyBoardView: (v: BoardView) => void }).applyBoardView(view());

  test("runs an ordinary edge left to right, from one card's right into the next card's left", async () => {
    const blocker = file("blocker");
    const waiting = file("waiting");
    addDependency(waiting.id, blocker.id, { now: AT });
    await mount({ view: view() });
    stubGeometry();
    redraw();

    // Done is column 0 and is empty here, so the two cards sit in columns 1 and 2.
    const [wire] = wires();
    expect(wire?.start).toBe(GUTTER + (COL_WIDTH + GAP) + COL_WIDTH);
    expect(wire?.end).toBe(GUTTER + 2 * (COL_WIDTH + GAP));
    expect(wire?.control).toBeGreaterThan(wire?.start as number);
    expect(wire?.control).toBeLessThan(wire?.end as number);
  });

  test("bows a same-column edge out to the left instead of looping it back over both cards", async () => {
    // Two finished tickets, one of which blocked the other. Both recede into Done, so the edge
    // between them has nowhere rightward to go.
    const first = file("first");
    const second = file("second");
    addDependency(second.id, first.id, { now: AT });
    updateTicket(first.id, { status: "done" }, { now: NOW });
    updateTicket(second.id, { status: "done" }, { now: NOW });
    await mount({ view: view() });
    stubGeometry();
    redraw();

    expect(seqsUnder("Done")).toEqual([first.seq, second.seq]);
    const [wire] = wires();
    // Out of the left and into the left — never out of the right, which is what looped.
    expect(wire?.start).toBe(GUTTER);
    expect(wire?.end).toBe(GUTTER);
    expect(wire?.control).toBeLessThan(GUTTER);
    // ...and still inside the tree, so the bow is visible rather than clipped off the page.
    expect(wire?.control).toBeGreaterThanOrEqual(0);
  });
});

describe("a long column", () => {
  /** One blocker fanning out to `count` tickets — the shape that makes a column long. */
  const fanOut = (count: number) => {
    const fan = file("the fan");
    for (let i = 1; i <= count; i++) {
      const kid = file(`ticket ${i}`);
      addDependency(kid.id, fan.id, { now: AT });
    }
    return fan;
  };

  test("renders every card, however many are stacked in one column", async () => {
    fanOut(26);
    await mount({ view: view() });
    expect(seqsUnder("Next")).toHaveLength(26);
    expect($$(".cols .card")).toHaveLength(27);
    // One wire per dependency, so nothing is silently dropped past some threshold.
    expect($$("#wires path")).toHaveLength(26);
  });

  test("keeps the fan's children adjacent rather than scattering them down the column", async () => {
    const fan = fanOut(20);
    // A second, unrelated root whose child would otherwise interleave by seq.
    const other = file("other root");
    const otherKid = file("other kid");
    addDependency(otherKid.id, other.id, { now: AT });
    await mount({ view: view() });

    const next = seqsUnder("Next");
    const fanKids = view()
      .cards.filter((c) => c.openBlockers.some((b) => b.seq === fan.seq))
      .map((c) => c.seq);
    const positions = fanKids.map((seq) => next.indexOf(seq)).toSorted((a, b) => a - b);
    // Contiguous: the highest position is exactly (count - 1) above the lowest.
    expect((positions.at(-1) as number) - (positions[0] as number)).toBe(fanKids.length - 1);
  });

  test("puts the legend above the tree, so a fan's colours are readable without scrolling", async () => {
    fanOut(26);
    await mount({ view: view() });
    const legend = $(".legend") as PageElement;
    const tree = $(".treescroll") as PageElement;
    // The legend explains the edge colours; on a long board it must not sit below 2000px of cards.
    // DOCUMENT_POSITION_FOLLOWING — the tree comes after the legend.
    expect(legend.compareDocumentPosition(tree as never) & 4).toBeTruthy();
  });

  test("bounds the rail so it can scroll to its own fog instead of overflowing the viewport", async () => {
    file("map", {
      labels: ["wayfinder:map"],
      body: "## Not yet specified\n\n- one open question\n",
    });
    fanOut(26);
    await mount({ view: view() });
    // happy-dom computes no layout, so the declaration is what gets asserted: the rail is capped to
    // the viewport and scrolls, which is what makes a rail taller than the screen usable at all.
    const rail = $(".rail") as PageElement;
    const style = win.getComputedStyle(rail as never);
    // happy-dom resolves the viewport unit, which is the point: the cap tracks the screen.
    expect(style.maxHeight).toBe(`calc(${win.innerHeight}px - 40px)`);
    expect(style.overflowY).toBe("auto");
    expect(rail.querySelector(".fogbox")).not.toBeNull();
  });
});

describe("every board on one surface", () => {
  const everywhere = () =>
    buildEverywhereView({ now: NOW, liveness: { known: true, liveSessions: [] } });

  test("lists what is dispatchable, grouped by board, with the command on each", async () => {
    const here = file("ready here");
    const there = createTicket({ workspace: "other", title: "ready there", now: AT });

    await mount({ view: null, everywhere: everywhere(), boards: ["kanban", "other"] });

    expect($$(".everyboard h2 .board-link").map((a) => a.textContent)).toEqual(["kanban", "other"]);
    expect($$(".ready-card .title").map((t) => t.textContent)).toEqual([
      "ready here",
      "ready there",
    ]);
    // The command each card carries is the board's own, workspace included — this surface is the
    // one place two boards' tickets sit together, so a command aimed at the wrong board would run.
    expect($$(".ready-card .copy").map((b) => b.getAttribute("data-dispatch"))).toEqual([
      dispatchCommand("kanban", here.seq, here.title),
      dispatchCommand("other", there.seq, there.title),
    ]);
    // No tree here: depth is per board, and one axis across boards would order the unrelated.
    expect($(".cols")).toBeNull();
  });

  test("says how much work there is, and where it is", async () => {
    file("ready here");
    createTicket({ workspace: "other", title: "ready there", now: AT });

    await mount({ view: null, everywhere: everywhere(), boards: ["kanban", "other"] });

    expect($(".frame h1")?.textContent).toBe("Ready to dispatch");
    expect($(".frame .dest")?.textContent).toContain("2 ready");
    expect($(".frame .dest")?.textContent).toContain("across 2 boards");
  });

  test("marks a ticket whose session is gone, and still offers its command", async () => {
    const abandoned = file("abandoned");
    updateClaim(abandoned.id, { session: "s-gone", at: AT });

    await mount({ view: null, everywhere: everywhere(), boards: ["kanban"] });

    expect($(".ready-card .chip.claim.gone")?.textContent).toContain("s-gone · gone");
    expect($(".ready-card .copy")).not.toBeNull();
    expect($(".frame .dest")?.textContent).toContain("1 to reclaim");
  });

  test("says so rather than showing an empty page when nothing is dispatchable", async () => {
    const blocker = file("blocker");
    const waiting = file("waiting");
    addDependency(waiting.id, blocker.id, { now: AT });
    updateClaim(blocker.id, { session: "s-alive", at: AT });
    const held = buildEverywhereView({
      now: NOW,
      liveness: { known: true, liveSessions: ["s-alive"] },
    });

    await mount({ view: null, everywhere: held, boards: ["kanban"] });

    expect($(".frame h1")?.textContent).toBe("Nothing is dispatchable right now");
    expect($$(".ready-card")).toHaveLength(0);
  });

  test("warns when liveness could not be read, since a live session may be listed", async () => {
    file("ready");
    await mount({ view: null, everywhere: buildEverywhereView({ now: NOW }), boards: ["kanban"] });
    expect($(".frame .oos")?.textContent).toContain("could not read the session registry");
  });

  test("is one entry in the selector, and a board name in the list switches to it", async () => {
    file("ready here");
    await mount({ view: null, everywhere: everywhere(), boards: ["kanban", "other"] });

    expect($("#drawer .board.every.on")?.getAttribute("data-board")).toBe("everywhere");
    expect($('.everyboard .board-link[data-board="kanban"]')?.getAttribute("href")).toBe(
      "/w/kanban",
    );
  });
});

// Boards accumulate — one is created by a workspace's first ticket and never removed — so the
// drawer is the part that has to survive fifty of them.
describe("the board drawer", () => {
  const many = [
    "servant-kanban",
    "datalake-loadtest",
    "ai_servant",
    "this_is_test145",
    "datalake-mvp",
    "task_abcd",
  ];

  const rows = () => $$("#drawer .dlist .board").map((a) => a.getAttribute("data-board"));

  const type = async (text: string) => {
    const input = $("#dfilter") as PageElement;
    (input as unknown as { value: string }).value = text;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    await win.happyDOM.waitUntilComplete();
  };

  test("keeps the server's order — most recently touched first — until asked otherwise", async () => {
    file("here");
    await mount({ view: view(), boards: many });
    expect(rows()).toEqual(many);
  });

  test("filters fuzzily, and ranks a tighter match above a looser one", async () => {
    file("here");
    await mount({ view: view(), boards: many });

    await type("dlm");
    expect(rows()).toEqual(["datalake-mvp"]);

    // Both datalake boards match; the shorter name breaks the tie.
    await type("dat");
    expect(rows()).toEqual(["datalake-mvp", "datalake-loadtest"]);

    // Initials beat a mid-word run: "sk" is the acronym of servant-kanban, and merely an adjacent
    // pair inside task_abcd. Typing the first letters of the words is how a name is usually recalled.
    await type("sk");
    expect(rows()[0]).toBe("servant-kanban");
    expect(rows()).toContain("task_abcd");

    await type("zzz");
    expect(rows()).toEqual([]);
    expect($("#drawer .empty")?.textContent).toContain("no board matches");
  });

  test("marks the characters that matched, so a fuzzy hit is legible", async () => {
    file("here");
    await mount({ view: view(), boards: many });
    await type("dlm");
    expect(
      $$("#drawer .dlist .board b")
        .map((b) => b.textContent)
        .join(""),
    ).toBe("dlm");
  });

  test("says what is on each board, since the name alone does not", async () => {
    file("here");
    await mount({ view: view(), boards: ["kanban", "other"] });
    expect($('#drawer .board[data-board="kanban"] .dwhen')?.textContent).toContain("1 open");
  });

  test("survives a live update with its filter and its caret intact", async () => {
    const t = file("here");
    await mount({ view: view(), boards: many });
    await type("dat");
    const before = rows();

    const moved = view();
    (win as unknown as { applyBoardView: (v: BoardView) => void }).applyBoardView(moved);
    await win.happyDOM.waitUntilComplete();

    // The board repainted; the drawer is outside that swap, so the filter did not blink out.
    expect(rows()).toEqual(before);
    expect(($("#dfilter") as unknown as { value: string }).value).toBe("dat");
    expect(t.seq).toBeGreaterThan(0);
  });

  test("closes and reopens, and remembers which for the next page", async () => {
    file("here");
    await mount({ view: view(), boards: many });
    expect(body().classList.contains("drawer")).toBe(true);

    click($("#drawertoggle") as PageElement);
    expect(body().classList.contains("drawer")).toBe(false);
    expect(win.localStorage.getItem("servant-board-drawer")).toBe("closed");

    click($("#drawertoggle") as PageElement);
    expect(body().classList.contains("drawer")).toBe(true);
    expect(win.localStorage.getItem("servant-board-drawer")).toBe("open");
  });

  test("Escape clears the filter first, and closes the drawer only once it is empty", async () => {
    file("here");
    await mount({ view: view(), boards: many });
    await type("dat");

    const escape = () =>
      ($("#dfilter") as PageElement).dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

    escape();
    expect(($("#dfilter") as unknown as { value: string }).value).toBe("");
    expect(body().classList.contains("drawer")).toBe(true);

    escape();
    expect(body().classList.contains("drawer")).toBe(false);
  });
});
