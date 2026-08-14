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
import type { BoardView, EverywhereView } from "./view.ts";

/**
 * What a subscriber watches: one board, or every board's frontier. The feed treats it as an opaque
 * key — it polls one counter for all of them, because `PRAGMA data_version` is per-database, not
 * per-board.
 */
export type FeedView = BoardView | EverywhereView;

export interface BoardFeedOptions {
  /** Builds the current view for a scope. Null when that scope no longer exists. */
  view: (scope: string) => FeedView | null;
  /** How often to ask whether another process has committed. */
  pollMs?: number;
  /** The slow rebuild that catches time-based change. 0 disables it. */
  sweepMs?: number;
}

export interface BoardFeed {
  subscribe(scope: string, onView: (view: FeedView) => void): () => void;
  stop(): void;
}

interface Subscriber {
  scope: string;
  onView: (view: FeedView) => void;
  /** The last view this subscriber was sent, so an unchanged scope pushes nothing. */
  last: string;
}

/**
 * A view's identity for change detection. `generatedAt` is dropped: it moves on every rebuild, and
 * a timestamp that always differs would turn every sweep into a push and every push into noise.
 */
function signature(view: FeedView): string {
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
    // One rebuild per scope, however many pages are watching it.
    const built = new Map<string, FeedView | null>();
    for (const sub of subscribers) {
      if (!built.has(sub.scope)) {
        try {
          built.set(sub.scope, opts.view(sub.scope));
        } catch {
          // A rebuild that throws — a transient lock, a half-applied migration — is a reason to
          // leave the last good view on screen, never a reason to tear down the feed.
          built.set(sub.scope, null);
        }
      }
      const view = built.get(sub.scope);
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
    subscribe(scope, onView) {
      const sub: Subscriber = { scope, onView, last: "" };
      // Seeded from the current view: the caller has already sent it, so re-sending it on the first
      // tick would be a duplicate frame for a board nothing has happened to.
      try {
        const current = opts.view(scope);
        if (current) sub.last = signature(current);
        seenVersion = boardDataVersion();
      } catch {
        // An unreadable scope now is one the first tick will pick up.
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
