// Who is working in a workspace, read from a fake registry — this machine's own live sessions are
// never in scope here, which is the point of injecting the reader.

import { describe, expect, test } from "bun:test";
import { workspacePath } from "../src/core/paths.ts";
import type { LiveSession } from "../src/core/session-registry.ts";
import { readWorkspaceSessions } from "../src/core/workspace-sessions.ts";

// Deliberately no root override: `applyRootOverride` is process-wide, and setting it at module
// scope leaks into every test file that runs after this one. Nothing here touches the disk — the
// registry is injected — so the real path is only ever used as a string to build fake cwds from.
const ROOT = workspacePath("ai_servant");

function session(overrides: Partial<LiveSession> & { name: string }): LiveSession {
  return { pid: 1, sessionId: "s", cwd: ROOT, status: "idle", ...overrides };
}

const registry = (sessions: LiveSession[]) => ({ live: async () => ({ known: true, sessions }) });

describe("reading who is working in a workspace", () => {
  test("a Worker session is reported with the ticket its name carries", async () => {
    const report = await readWorkspaceSessions(
      "ai_servant",
      registry([session({ name: "ai-servant-t24", status: "busy" })]),
    );

    expect(report).toEqual({
      known: true,
      sessions: [{ name: "ai-servant-t24", kind: "worker", ticket: 24, status: "busy", pid: 1 }],
    });
  });

  test("a Hands session is named as what it is, and carries no ticket", async () => {
    const report = await readWorkspaceSessions(
      "ai_servant",
      registry([session({ name: "ai-servant-hands" })]),
    );

    expect(report).toMatchObject({
      sessions: [{ kind: "hands", ticket: null }],
    });
  });

  test("a session the user started by hand is still reported, just as no one's ticket", async () => {
    const report = await readWorkspaceSessions(
      "ai_servant",
      registry([session({ name: "ai-servant-70" })]),
    );

    expect(report).toMatchObject({ sessions: [{ kind: "other", ticket: null }] });
  });

  test("sessions working in another workspace are not this workspace's", async () => {
    const report = await readWorkspaceSessions(
      "ai_servant",
      registry([
        session({ name: "ai-servant-t24" }),
        session({ name: "datalake-mvp-59", cwd: workspacePath("datalake-mvp") }),
      ]),
    );

    expect(report).toMatchObject({ sessions: [{ name: "ai-servant-t24" }] });
  });

  test("a session in a mounted repo counts — it is working in the workspace either way", async () => {
    const report = await readWorkspaceSessions(
      "ai_servant",
      registry([session({ name: "ai-servant-t26", cwd: `${ROOT}/repos/ai-servant-cli__x` })]),
    );

    expect(report).toMatchObject({ sessions: [{ name: "ai-servant-t26" }] });
  });

  test("a workspace whose name is a prefix of another's does not claim its sessions", async () => {
    const report = await readWorkspaceSessions(
      "api",
      registry([session({ name: "api-old-t3", cwd: `${workspacePath("api")}-old` })]),
    );

    expect(report).toEqual({ known: true, sessions: [] });
  });

  test("a registry whose shape has moved is unknown, not an empty workspace", async () => {
    const report = await readWorkspaceSessions(
      "ai_servant",
      // What version skew looks like: entries are there, but the fields this reads have moved.
      registry([session({ name: null as unknown as string, cwd: null })]),
    );

    expect(report).toEqual({ known: false });
  });

  test("an unreadable registry is unknown, never an empty workspace", async () => {
    const report = await readWorkspaceSessions("ai_servant", {
      live: async () => ({ known: false }),
    });

    // Reporting "nobody is working" from a registry this host cannot read is the answer that gets
    // two sessions into one worktree (ADR 0010).
    expect(report).toEqual({ known: false });
  });
});
