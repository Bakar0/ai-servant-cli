// Turning the raw registry into an answer safe to act on.

import { describe, expect, test } from "bun:test";
import { liveSessionNames } from "../src/core/session-registry.ts";

// The bug review found on both axes, and the most dangerous thing in this change. Liveness feeds
// staleness, staleness is reclaimed *silently*, and a reclaim spawns a second session onto a live
// worktree — the exact failure Claims exist to prevent (workspace ADR 0010). So anything short of
// a trustworthy enumeration has to report unknown rather than a short list of names.
describe("liveness only speaks when it can be trusted", () => {
  const named = (name: string | null, pid = 100) => ({
    pid,
    name,
    sessionId: "s",
    cwd: "/ws",
    status: "idle",
  });

  test("a registry it could not read at all is unknown", () => {
    expect(liveSessionNames({ known: false })).toEqual({ known: false });
  });

  // An empty registry is the ambiguous one: it looks identical whether every session exited or
  // the directory moved. Read as "nobody is alive" it turns every Claim stale at once.
  test("an empty registry is unknown, not 'nobody is alive'", () => {
    expect(liveSessionNames({ known: true, sessions: [] })).toEqual({ known: false });
  });

  test("entries the registry could not name mean the shape moved — unknown", () => {
    const report = liveSessionNames({ known: true, sessions: [named("ws-t1"), named(null, 101)] });

    expect(report).toEqual({ known: false });
  });

  test("a registry that named everything it holds is trusted", () => {
    const report = liveSessionNames({
      known: true,
      sessions: [named("ws-t1"), named("ws-hands", 101)],
    });

    expect(report).toEqual({ known: true, names: ["ws-t1", "ws-hands"] });
  });
});
