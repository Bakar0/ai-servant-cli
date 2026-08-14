import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDependency, closeBoard, createTicket, listBoards } from "../src/core/board/store.ts";
import { createBoardFeed } from "../src/core/board/feed.ts";
import {
  BOARD_DATA_SLOT,
  SSE_HEARTBEAT,
  handleBoardRequest,
  serveBoard,
  sseFrame,
} from "../src/core/board/server.ts";
import type { BoardHandlerDeps } from "../src/core/board/server.ts";
import { BOARD_TEMPLATE } from "../src/core/board/board-template.ts";
import { buildBoardView } from "../src/core/board/view.ts";
import type { BoardView } from "../src/core/board/view.ts";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-board-server-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const AT = "2026-08-14T10:00:00.000Z";
const WS = "kanban";

const file = (title: string, over: Record<string, unknown> = {}) =>
  createTicket({ workspace: WS, title, now: AT, ...over });

const deps = (over: Partial<BoardHandlerDeps> = {}): BoardHandlerDeps => ({
  view: (workspace) =>
    listBoards().includes(workspace) ? buildBoardView(workspace, { now: AT }) : null,
  boards: listBoards,
  heartbeatMs: 0,
  ...over,
});

const get = (path: string, over: Partial<BoardHandlerDeps> = {}) =>
  handleBoardRequest(new Request(`http://127.0.0.1:7787${path}`), deps(over));

/** The payload the page was handed, read back the way the browser would. */
function payload(html: string): { view: BoardView | null; focus: number | null; boards: string[] } {
  const start = html.indexOf("const DATA = ");
  if (start < 0) throw new Error("the page never assigned its data");
  const json = html.slice(start + "const DATA = ".length, html.indexOf(";\n", start));
  return JSON.parse(json);
}

describe("routing", () => {
  test("serves the board page for a workspace, with the view already in it", async () => {
    file("only ticket");
    const res = get(`/w/${WS}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).not.toContain(BOARD_DATA_SLOT);
    const data = payload(html);
    expect(data.view?.workspace).toBe(WS);
    expect(data.view?.cards).toHaveLength(1);
    expect(data.focus).toBeNull();
  });

  test("a ticket's own URL is a deep link that focuses it", async () => {
    const t = file("deep linked");
    const url = new URL(t.url);
    expect(url.pathname).toBe(`/w/${WS}/t/${t.seq}`);
    const data = payload(await get(url.pathname).text());
    expect(data.focus).toBe(t.seq);
  });

  test("redirects the root to the only board there is", () => {
    file("only ticket");
    const res = get("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/w/${WS}`);
  });

  test("offers a picker when more than one board exists", async () => {
    file("here");
    createTicket({ workspace: "other", title: "there", now: AT });
    const res = get("/");
    expect(res.status).toBe(200);
    const data = payload(await res.text());
    expect(data.view).toBeNull();
    expect(data.boards.toSorted((a, b) => a.localeCompare(b))).toEqual(["kanban", "other"]);
  });

  test("serves an empty-state page rather than an error when nothing has been filed", async () => {
    const res = get("/");
    expect(res.status).toBe(200);
    expect(payload(await res.text()).boards).toEqual([]);
  });

  test("404s an unknown board and an unknown path", () => {
    file("t");
    expect(get("/w/nope").status).toBe(404);
    expect(get("/w/kanban/nonsense").status).toBe(404);
    expect(get("/nonsense").status).toBe(404);
    expect(get("/w/kanban/t/0").status).toBe(404);
    expect(get("/w/kanban/t/abc").status).toBe(404);
  });

  test("exposes the same view as JSON, so nothing is rendered twice", async () => {
    file("t");
    const res = get(`/api/w/${WS}`);
    expect(res.headers.get("content-type")).toContain("application/json");
    const view = (await res.json()) as BoardView;
    expect(view).toEqual(payload(await get(`/w/${WS}`).text()).view as BoardView);
  });

  test("is read-only: every method that could write is refused before any route matches", () => {
    file("t");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = handleBoardRequest(
        new Request(`http://127.0.0.1:7787/w/${WS}`, { method }),
        deps(),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
  });
});

describe("the SSE stream", () => {
  test("frames an event the way the browser parses one", () => {
    expect(sseFrame("view", { a: 1 })).toBe('event: view\ndata: {"a":1}\n\n');
    expect(SSE_HEARTBEAT).toBe(": ping\n\n");
  });

  test("splits a multi-line payload into one data line each, so the frame stays valid", () => {
    // JSON.stringify never emits a raw newline, but the framing must not depend on that.
    const frame = sseFrame("view", "a\nb");
    expect(frame.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  test("opens with the current view, before anything has changed", async () => {
    const t = file("first");
    const res = get(`/w/${WS}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const frame = await readFrame(res);
    expect(frame.startsWith("event: view\ndata: ")).toBe(true);
    const view = JSON.parse(frame.slice("event: view\ndata: ".length)) as BoardView;
    expect(view.cards.map((c) => c.seq)).toEqual([t.seq]);
  });

  test("pushes a frame per change, and stops when the page goes away", async () => {
    file("first");
    const listeners: ((view: BoardView) => void)[] = [];
    let unsubscribed = 0;
    const res = get(`/w/${WS}/events`, {
      subscribe: (_ws, onView) => {
        listeners.push(onView);
        return () => {
          unsubscribed += 1;
        };
      },
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the opening view

    const second = buildBoardView(WS, { now: AT });
    for (const listener of listeners) listener(second);
    const pushed = new TextDecoder().decode((await reader.read()).value);
    expect(pushed.startsWith("event: view\n")).toBe(true);

    await reader.cancel();
    expect(unsubscribed).toBe(1);
  });

  test("404s the stream for a board that does not exist, rather than an empty stream", () => {
    expect(get("/w/nope/events").status).toBe(404);
  });

  test("sends a heartbeat so an idle connection is not reaped", async () => {
    file("t");
    const res = get(`/w/${WS}/events`, { heartbeatMs: 5 });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(SSE_HEARTBEAT);
    await reader.cancel();
  });
});

describe("the live feed", () => {
  test("a change written by a real servant command reaches an open page with no reload", async () => {
    const blocker = file("blocker");
    const waiting = file("waiting");
    addDependency(waiting.id, blocker.id, { now: AT });

    const feed = createBoardFeed({
      view: (ws) => (listBoards().includes(ws) ? buildBoardView(ws) : null),
      pollMs: 25,
      // The commit trigger alone, so this proves the change arrived rather than the clock ticking.
      sweepMs: 0,
    });
    try {
      const pushed = new Promise<BoardView>((resolve) => {
        feed.subscribe(WS, resolve);
      });

      // The actual CLI, in its own process, against this board. Nothing tells the feed it ran.
      const closed = Bun.spawnSync([
        "bun",
        "run",
        "src/index.ts",
        "ticket",
        "close",
        String(blocker.seq),
        "--ws",
        WS,
        "--root",
        tmpRoot,
      ]);
      expect(new TextDecoder().decode(closed.stderr)).toBe("");
      expect(closed.exitCode).toBe(0);

      const view = await withTimeout(pushed, 5000, "the feed never pushed the change");
      const card = view.cards.find((c) => c.seq === waiting.seq);
      expect(card?.column).toBe("ready");
      expect(card?.depth).toBe(0);
    } finally {
      feed.stop();
    }
  });

  test("says nothing when nothing changed", async () => {
    file("t");
    const feed = createBoardFeed({
      view: (ws) => (listBoards().includes(ws) ? buildBoardView(ws) : null),
      pollMs: 5,
      sweepMs: 10,
    });
    try {
      let pushes = 0;
      feed.subscribe(WS, () => {
        pushes += 1;
      });
      await Bun.sleep(120);
      expect(pushes).toBe(0);
    } finally {
      feed.stop();
    }
  });

  test("the template carries exactly one data slot, so the fill cannot land in the wrong place", () => {
    expect(BOARD_TEMPLATE.split(BOARD_DATA_SLOT)).toHaveLength(2);
  });
});

describe("serveBoard", () => {
  test("binds loopback only, and nothing on the network can reach it", async () => {
    file("t");
    const server = serveBoard({ port: 0, deps: deps() });
    try {
      expect(server.url).toStartWith("http://127.0.0.1:");
      expect((await fetch(`${server.url}/w/${WS}`)).status).toBe(200);

      // The socket is bound to the loopback address, so a request addressed to this machine's
      // routable address is refused at connect time rather than served.
      const external = nonLoopbackAddress();
      if (external) {
        await expect(fetch(`http://${external}:${server.port}/w/${WS}`)).rejects.toThrow();
      }
    } finally {
      server.stop();
    }
  });
});

// ── helpers ───────────────────────────────────────────────────────────

async function readFrame(res: Response): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** This host's routable IPv4 address, when it has one. Null on a machine with only loopback. */
function nonLoopbackAddress(): string | null {
  const nets = Object.values(require("node:os").networkInterfaces()).flat() as {
    family: string;
    internal: boolean;
    address: string;
  }[];
  return nets.find((n) => n && n.family === "IPv4" && !n.internal)?.address ?? null;
}

describe("the viewer is not in anyone's way", () => {
  test("no other command can reach the server or the feed, so closing it changes nothing", async () => {
    const commands = new Bun.Glob("src/commands/**/*.ts");
    const reachable: string[] = [];
    for await (const path of commands.scan(".")) {
      if (path.endsWith("commands/board.ts")) continue;
      const source = await Bun.file(path).text();
      if (/board\/(server|feed)\.ts/.test(source)) reachable.push(path);
    }
    expect(reachable).toEqual([]);
  });

  test("and the viewer never writes: it opens the board only through reads", async () => {
    const writes = ["createTicket", "updateTicket", "updateClaim", "addDependency", "addComment"];
    for (const path of [
      "src/core/board/server.ts",
      "src/core/board/feed.ts",
      "src/commands/board.ts",
    ]) {
      const source = await Bun.file(path).text();
      // recordSessionsSeen is the tempting one: refreshing the last-seen projection from the
      // viewer would make it a writer, and "the viewer never writes" is what the CLI relies on.
      for (const write of [...writes, "recordSessionsSeen", "recordAction"]) {
        expect(`${path}: ${source.includes(`${write}(`)}`).toBe(`${path}: false`);
      }
    }
  });
});
