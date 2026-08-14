// `servant board` — a lens on the board file, never a gate in front of it (ADR-0011 decision 1).
//
// Nothing here writes. The viewer opens the same SQLite file every servant command opens, reads it,
// and pushes what it read; close the viewer and every command still works, because no command ever
// went through it. That is the entire arrangement, and it is why this file has no write path to
// review — the absence is the design.
//
// The routing is a plain `Request` → `Response` function so the whole surface, SSE framing included,
// is asserted without binding a port. `serveBoard` is the thin part that does bind one.

import { BOARD_VIEWER_PORT } from "../paths.ts";
import { fillDataSlot } from "../html-artifact.ts";
import { BOARD_TEMPLATE } from "./board-template.ts";
import type { BoardView, EverywhereView } from "./view.ts";

export const BOARD_DATA_SLOT = "__BOARD_DATA__";

/** The `/everywhere` scope, as a subscription key and as a URL segment. */
export const EVERYWHERE = "everywhere";

/** What the page is handed: the view, which board it is, and which ticket the URL singled out. */
export interface BoardPayload {
  boards: string[];
  workspace: string | null;
  view: BoardView | null;
  /** Set on `/everywhere` only, and then `view` is null: the two are alternative surfaces. */
  everywhere: EverywhereView | null;
  /** The ticket a `/w/<ws>/t/<seq>` deep link named — `ticketUrl()`'s half of the contract. */
  focus: number | null;
  eventsPath: string | null;
}

export interface BoardHandlerDeps {
  /** The view for one board, or null when no such board exists. */
  view: (workspace: string) => BoardView | null;
  /** Every board's frontier at once. */
  everywhere: () => EverywhereView;
  boards: () => string[];
  /**
   * Register for views of a scope as it changes — a board's name, or `EVERYWHERE`; returns an
   * unsubscribe. Injected so the handler's framing is testable on its own — the real one watches
   * the database file.
   */
  subscribe?: (scope: string, onView: (view: BoardView | EverywhereView) => void) => () => void;
  template?: string;
  /** Comment-frame interval. 0 disables it, which is what a test that reads a fixed number wants. */
  heartbeatMs?: number;
}

/**
 * One SSE frame. Written out rather than assembled inline because the format is exact — a missing
 * blank line makes a frame that never dispatches, and that failure looks like "no updates".
 */
export function sseFrame(event: string, data: unknown): string {
  const body = JSON.stringify(data);
  // A data line cannot contain a newline; a multi-line payload is multiple `data:` lines, which the
  // browser rejoins with "\n". JSON.stringify never emits a raw newline, but splitting is free and
  // makes the frame correct for any payload rather than only this one.
  const lines = body.split("\n").map((line) => `data: ${line}`);
  return `event: ${event}\n${lines.join("\n")}\n\n`;
}

/** A comment frame. Keeps an idle connection from being reaped without looking like an update. */
export const SSE_HEARTBEAT = ": ping\n\n";

function page(payload: BoardPayload, template: string): Response {
  return new Response(fillDataSlot(template, BOARD_DATA_SLOT, payload), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The board changes under the page; a cached copy would be a lie the moment it was served.
      "cache-control": "no-store",
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function notFound(message: string): Response {
  return new Response(`${message}\n`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** `/w/<workspace>` and `/w/<workspace>/t/<seq>` and `/w/<workspace>/events`. */
function parsePath(pathname: string): { workspace: string; rest: string[] } | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "w" || parts[1] === undefined || parts[1] === "") return null;
  return { workspace: parts[1], rest: parts.slice(2) };
}

function eventsPath(workspace: string): string {
  return `/w/${encodeURIComponent(workspace)}/events`;
}

/**
 * The whole HTTP surface.
 *
 * Read-only by construction: every method other than GET is refused before a route is even matched,
 * so there is no path through this function that could mediate a write.
 */
export function handleBoardRequest(req: Request, deps: BoardHandlerDeps): Response {
  const template = deps.template ?? BOARD_TEMPLATE;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("The board viewer is read-only.\n", {
      status: 405,
      headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const url = new URL(req.url);
  const boards = deps.boards();

  if (url.pathname === "/") {
    // One board is the ordinary case, and a picker in front of it would be a click for nothing.
    if (boards.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: `/w/${encodeURIComponent(boards[0] as string)}` },
      });
    }
    return page(
      { boards, workspace: null, view: null, everywhere: null, focus: null, eventsPath: null },
      template,
    );
  }

  // `/api/w/<ws>` is the same view the page gets, without the page — the shape every assertion and
  // every `curl` reads, so the JSON is never a second rendering of the board.
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  const path = isApi ? url.pathname.slice("/api".length) : url.pathname;

  // Every board's frontier at once. A surface of its own rather than a board named "everywhere",
  // because it answers a different question and has no tree to draw.
  if (path === `/${EVERYWHERE}` || path === `/${EVERYWHERE}/events`) {
    const everywhere = deps.everywhere();
    if (path.endsWith("/events")) {
      return isApi ? notFound("No such page.") : eventStream(EVERYWHERE, everywhere, deps);
    }
    if (isApi) return json(everywhere);
    return page(
      {
        boards,
        workspace: null,
        view: null,
        everywhere,
        focus: null,
        eventsPath: `/${EVERYWHERE}/events`,
      },
      template,
    );
  }

  const route = parsePath(path);
  if (!route) return notFound("No such page.");
  const { workspace, rest } = route;

  const view = deps.view(workspace);
  if (!view) return notFound(`No board for the "${workspace}" workspace.`);

  if (!isApi && rest[0] === "events" && rest.length === 1) {
    return eventStream(workspace, view, deps);
  }

  if (isApi) return rest.length === 0 ? json(view) : notFound("No such page.");

  let focus: number | null = null;
  if (rest[0] === "t" && rest[1] !== undefined) {
    const seq = Number(rest[1]);
    if (!Number.isInteger(seq) || seq <= 0) return notFound("A ticket is a positive number.");
    focus = seq;
  } else if (rest.length > 0) {
    return notFound("No such page.");
  }

  return page(
    { boards, workspace, view, everywhere: null, focus, eventsPath: eventsPath(workspace) },
    template,
  );
}

/**
 * The live half: the current view immediately, then one frame per change.
 *
 * The first frame is sent before any change happens so a page that connects late is correct without
 * waiting for the next write — a stream whose first useful frame needs someone else to do something
 * is indistinguishable from a broken one.
 */
function eventStream(
  scope: string,
  initial: BoardView | EverywhereView,
  deps: BoardHandlerDeps,
): Response {
  const subscribe = deps.subscribe;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The page navigated away between the change and this write. Not an error: stop pushing.
          close();
        }
      };
      // The two scopes carry different shapes, so they get different frame names — a page that had
      // to guess which it received could paint one surface with the other's data.
      const event = scope === EVERYWHERE ? EVERYWHERE : "view";
      send(sseFrame(event, initial));
      if (subscribe) unsubscribe = subscribe(scope, (view) => send(sseFrame(event, view)));
      const every = deps.heartbeatMs ?? 15_000;
      if (every > 0) heartbeat = setInterval(() => send(SSE_HEARTBEAT), every);
    },
    cancel: close,
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

export interface ServeBoardOptions {
  port?: number;
  deps: BoardHandlerDeps;
}

export interface BoardServer {
  port: number;
  url: string;
  stop: () => void;
}

/**
 * Bind the viewer. **Loopback only** — `hostname` is fixed at 127.0.0.1 rather than defaulted, so
 * there is no argument, env var or config file that can put this board on a network. Single user,
 * no auth, and the only way to keep that safe is for the socket never to leave the machine.
 */
export function serveBoard(opts: ServeBoardOptions): BoardServer {
  const port = opts.port ?? BOARD_VIEWER_PORT;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // No idle timeout: an SSE connection is idle by nature between writes, and being hung up on is
    // exactly the failure the heartbeat exists to prevent.
    idleTimeout: 0,
    fetch: (req) => handleBoardRequest(req, opts.deps),
  });
  // `server.port` is the bound port, which differs from the requested one when 0 asks for any free
  // one. It is optional in Bun's types only because a unix-socket server has none.
  const bound = server.port ?? port;
  return {
    port: bound,
    url: `http://127.0.0.1:${bound}`,
    stop: () => void server.stop(true),
  };
}
