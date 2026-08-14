// `servant board` — open the board.
//
// The one command that binds a port, and the one command nothing else depends on: every other
// servant command opens the SQLite file directly, so closing this one changes nothing about them
// (ADR-0011 decision 1).

import { defineCommand } from "citty";
import { createBoardFeed } from "../core/board/feed.ts";
import { EVERYWHERE, serveBoard } from "../core/board/server.ts";
import { listBoards } from "../core/board/store.ts";
import { buildBoardView, buildEverywhereView } from "../core/board/view.ts";
import { openInDefaultApp } from "../core/open.ts";
import { applyRootOverride, BOARD_VIEWER_PORT } from "../core/paths.ts";
import { readLiveSessions } from "../core/session-registry.ts";
import type { ClaimLiveness } from "../core/tasks.ts";
import { resolveWorkspaceName } from "../core/workspace.ts";

/**
 * Liveness, re-read on a timer rather than per request.
 *
 * A PID sweep per SSE frame would make the process table the cost of watching a board. Cached for a
 * few seconds and refreshed in the background: a claim badge that is seconds behind is fine, and
 * "unknown" until the first read completes is the safe direction to be wrong in.
 *
 * A read, and only a read. The obvious next step — refreshing the board's last-seen projection from
 * what this just learned — is deliberately not taken: it would make the viewer a writer, and "the
 * viewer never writes" is the property the whole arrangement rests on. The projection stays fresh
 * the way ADR-0011 decision 3 says it does, from whichever servant command happens to run.
 */
function createLivenessCache(everyMs: number) {
  let current: ClaimLiveness = { known: false };
  let timer: ReturnType<typeof setInterval> | null = null;
  const refresh = async () => {
    const live = await readLiveSessions();
    current = live.known
      ? {
          known: true,
          liveSessions: live.sessions
            .map((s) => s.name)
            .filter((name): name is string => name !== null),
        }
      : { known: false };
  };
  return {
    get: () => current,
    start() {
      // Swallowed rather than ignored: an unreadable process table is an ordinary answer here, and
      // an unhandled rejection would take down a process whose whole job is to keep running.
      const tick = () => void refresh().catch(() => {});
      tick();
      timer = setInterval(tick, everyMs);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

export const boardCommand = defineCommand({
  meta: {
    name: "board",
    description:
      "Open the board: a live kanban and wayfinder map over the local tracker, served on loopback. Read-only — every servant command keeps working with it closed.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Which board to open (default: the current workspace).",
    },
    port: {
      type: "string",
      required: false,
      description: `Loopback port (default: ${BOARD_VIEWER_PORT}, which is what a ticket's URL assumes).`,
    },
    "no-open": {
      type: "boolean",
      required: false,
      default: false,
      description: "Serve and print the URL, but don't open the browser.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const port = args.port === undefined ? BOARD_VIEWER_PORT : Number(args.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`servant board: --port must be a port number, got "${String(args.port)}".`);
    }

    const boards = listBoards();
    const requested = typeof args.workspace === "string" ? args.workspace.trim() : "";
    // Only fall back to the cwd's workspace when the board actually exists — landing on a 404 for a
    // workspace that has never carried a ticket is worse than landing on the picker.
    const detected = requested || (await resolveWorkspaceName(undefined).catch(() => ""));
    const workspace = boards.includes(detected) ? detected : "";
    if (requested && !boards.includes(requested)) {
      throw new Error(
        `servant board: no board for the "${requested}" workspace.` +
          (boards.length ? ` Known boards: ${boards.join(", ")}.` : " Nothing has been filed yet."),
      );
    }

    const liveness = createLivenessCache(4_000);
    liveness.start();

    const view = (name: string) =>
      listBoards().includes(name) ? buildBoardView(name, { liveness: liveness.get() }) : null;
    const everywhere = () => buildEverywhereView({ liveness: liveness.get() });
    // One feed over both surfaces: a scope is a board's name, or `EVERYWHERE`.
    const feed = createBoardFeed({
      view: (scope) => (scope === EVERYWHERE ? everywhere() : view(scope)),
    });

    let server: ReturnType<typeof serveBoard>;
    try {
      server = serveBoard({
        port,
        deps: {
          view,
          everywhere,
          boards: () => listBoards(),
          subscribe: (scope, onView) => feed.subscribe(scope, onView),
        },
      });
    } catch (error) {
      liveness.stop();
      feed.stop();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `servant board: could not bind 127.0.0.1:${port} — ${reason}\n` +
          "  Another viewer is probably already running; open it, or pass --port.",
        { cause: error },
      );
    }

    const target = workspace ? `${server.url}/w/${encodeURIComponent(workspace)}` : server.url;
    console.log(`servant: the board is at ${target}`);
    console.log("  loopback only · read-only · every servant command works with this closed");
    console.log("  Ctrl-C to stop.");
    if (!args["no-open"]) openInDefaultApp(target);

    const shutdown = () => {
      feed.stop();
      liveness.stop();
      server.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Hold the process open: Bun.serve alone does not keep an async `run` from returning.
    await new Promise<never>(() => {});
  },
});
