// How a change made by a servant command reaches an open page.
//
// There is no notification channel between the CLI and the viewer, and deliberately so: a command
// that had to tell the viewer would be a command that depends on the viewer. So the viewer asks the
// database instead. `servant ticket close` writes SQLite and exits knowing nothing; the page moves.
//
// Two triggers, because either alone has a gap the other covers:
//   · `PRAGMA data_version` moves the instant another process commits, and is what makes a card
//     migrate while you watch it. A filesystem watch was tried first and is not usable — a WAL
//     commit appends to `board.sqlite-wal` and macOS reports no event for a plain append, so most
//     writes never arrive.
//   · a slow sweep catches what a version counter cannot see at all: the last-seen ages on claim
//     badges, which go stale with the passage of time rather than with any write.

import { boardDataVersion } from "./store.ts";
import type { BoardView } from "./view.ts";

export interface BoardFeedOptions {
  /** Builds the current view for a board. Null when that board no longer exists. */
  view: (workspace: string) => BoardView | null;
  /** How often to ask whether another process has committed. */
  pollMs?: number;
  /** The slow rebuild that catches time-based change. 0 disables it. */
  sweepMs?: number;
}

export interface BoardFeed {
  subscribe(workspace: string, onView: (view: BoardView) => void): () => void;
  stop(): void;
}

interface Subscriber {
  workspace: string;
  onView: (view: BoardView) => void;
  /** The last view this subscriber was sent, so an unchanged board pushes nothing. */
  last: string;
}

/**
 * A view's identity for change detection. `generatedAt` is dropped: it moves on every rebuild, and
 * a timestamp that always differs would turn every sweep into a push and every push into noise.
 */
function signature(view: BoardView): string {
  const { generatedAt: _ignored, ...rest } = view;
  return JSON.stringify(rest);
}

export function createBoardFeed(opts: BoardFeedOptions): BoardFeed {
  const pollMs = opts.pollMs ?? 250;
  const sweepMs = opts.sweepMs ?? 5_000;
  const subscribers = new Set<Subscriber>();
  let poll: ReturnType<typeof setInterval> | null = null;
  let sweep: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let seenVersion = 0;

  const publish = () => {
    if (stopped || subscribers.size === 0) return;
    // One rebuild per board, however many pages are watching it.
    const built = new Map<string, BoardView | null>();
    for (const sub of subscribers) {
      if (!built.has(sub.workspace)) {
        try {
          built.set(sub.workspace, opts.view(sub.workspace));
        } catch {
          // A rebuild that throws — a transient lock, a half-applied migration — is a reason to
          // leave the last good view on screen, never a reason to tear down the feed.
          built.set(sub.workspace, null);
        }
      }
      const view = built.get(sub.workspace);
      if (!view) continue;
      const next = signature(view);
      if (next === sub.last) continue;
      sub.last = next;
      sub.onView(view);
    }
  };

  const checkForCommits = () => {
    if (stopped) return;
    let version: number;
    try {
      version = boardDataVersion();
    } catch {
      return;
    }
    if (version === seenVersion) return;
    seenVersion = version;
    publish();
  };

  const startTimers = () => {
    if (stopped) return;
    if (poll === null && pollMs > 0) poll = setInterval(checkForCommits, pollMs);
    if (sweep === null && sweepMs > 0) sweep = setInterval(publish, sweepMs);
  };

  return {
    subscribe(workspace, onView) {
      const sub: Subscriber = { workspace, onView, last: "" };
      // Seeded from the current view: the caller has already sent it, so re-sending it on the first
      // tick would be a duplicate frame for a board nothing has happened to.
      try {
        const current = opts.view(workspace);
        if (current) sub.last = signature(current);
        seenVersion = boardDataVersion();
      } catch {
        // An unreadable board now is one the first tick will pick up.
      }
      subscribers.add(sub);
      startTimers();
      return () => {
        subscribers.delete(sub);
      };
    },
    stop() {
      stopped = true;
      subscribers.clear();
      if (poll !== null) clearInterval(poll);
      poll = null;
      if (sweep !== null) clearInterval(sweep);
      sweep = null;
    },
  };
}
