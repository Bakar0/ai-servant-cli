import { describe, expect, test } from "bun:test";
import type { ClaudeSessionMeta } from "../src/core/claude-session.ts";
import type { SessionLiveness } from "../src/core/session-registry.ts";
import type { LaunchWorkspaceSessionOptions } from "../src/core/spawn.ts";
import {
  composeDelegationPrompt,
  createSummonsActions,
  delegationSessionName,
} from "../src/core/summons-delegate.ts";

/** Records the order of claim and launch, which is the property that matters most here. */
function fakeWorld(launchFails = false) {
  const order: string[] = [];
  const launches: LaunchWorkspaceSessionOptions[] = [];
  const actions = createSummonsActions({
    workspace: "ai_servant",
    hubRepo: "acme/hub",
    async claim(_hub, ticket, session) {
      order.push(`claim #${ticket} for ${session}`);
      return { transferredFrom: null, alreadyHeld: false };
    },
    async release(_hub, ticket, session) {
      order.push(`release #${ticket} from ${session}`);
    },
    async launch(opts) {
      order.push(`launch ${opts.sessionName}`);
      launches.push(opts);
      if (launchFails) throw new Error("no terminal available");
      return {
        workspace: "ai_servant",
        cwd: "/tmp/ws",
        terminal: "faketerm",
        command: "claude",
        sessionName: opts.sessionName ?? null,
      };
    },
  });
  return { actions, order, launches };
}

describe("naming a delegated session", () => {
  test("ticketed work is addressable from the ticket alone", () => {
    expect(
      delegationSessionName("ai_servant", { task: "t", label: "l", readOnly: false, ticket: 17 }),
    ).toBe("ai-servant-t17");
  });

  test("ad-hoc work, having no ticket to derive from, is addressed by its label", () => {
    expect(
      delegationSessionName("ai_servant", { task: "t", label: "API research", readOnly: false }),
    ).toBe("ai-servant-api-research");
  });
});

describe("what the delegated session wakes up to", () => {
  const prompt = (overrides = {}) =>
    composeDelegationPrompt({
      workspace: "ai_servant",
      hubRepo: "acme/hub",
      sessionName: "ai-servant-t17",
      request: {
        task: "port the parser to the new tokenizer",
        label: "parser port",
        readOnly: false,
        ticket: 17,
        repo: "backend",
        conversation: "user: the parser chokes on unicode",
        ...overrides,
      },
    });

  test("it carries the stated task", () => {
    expect(prompt()).toContain("port the parser to the new tokenizer");
  });

  test("it carries the conversation the request came out of", () => {
    expect(prompt()).toContain("user: the parser chokes on unicode");
  });

  test("it names the repo the work touches", () => {
    expect(prompt()).toContain("backend");
  });

  test("it tells the session how to release its Claim, since nothing else will", () => {
    expect(prompt()).toContain("servant claim 17 --release --session ai-servant-t17");
  });

  test("ad-hoc work carries no claim instruction, having no ticket", () => {
    const adhoc = composeDelegationPrompt({
      workspace: "ai_servant",
      hubRepo: "acme/hub",
      sessionName: "ai-servant-research",
      request: { task: "research X", label: "research", readOnly: false },
    });
    expect(adhoc).not.toContain("servant claim");
  });
});

describe("delegating is one step, not two", () => {
  test("the Claim is written before the session is launched", async () => {
    const { actions, order } = fakeWorld();

    await actions.delegate({
      task: "port the parser",
      label: "parser port",
      readOnly: false,
      ticket: 17,
    });

    // Claiming after launching would leave a window in which a running session is unclaimed —
    // exactly when a second one gets dispatched onto the same ticket and worktree.
    expect(order).toEqual(["claim #17 for ai-servant-t17", "launch ai-servant-t17"]);
  });

  test("a launch that fails hands the Claim back, so the ticket is not left held by nothing", async () => {
    const { actions, order } = fakeWorld(true);

    await expect(
      actions.delegate({
        task: "port the parser",
        label: "parser port",
        readOnly: false,
        ticket: 17,
      }),
    ).rejects.toThrow("no terminal available");

    expect(order).toEqual([
      "claim #17 for ai-servant-t17",
      "launch ai-servant-t17",
      "release #17 from ai-servant-t17",
    ]);
  });

  test("ad-hoc work claims nothing", async () => {
    const { actions, order } = fakeWorld();

    const handle = await actions.delegate({
      task: "research X",
      label: "research",
      readOnly: false,
    });

    expect(order).toEqual(["launch ai-servant-research"]);
    expect(handle.sessionName).toBe("ai-servant-research");
  });

  test("the session is launched under its name, with the composed prompt", async () => {
    const { actions, launches } = fakeWorld();

    await actions.delegate({
      task: "port the parser",
      label: "parser port",
      readOnly: false,
      ticket: 17,
    });

    expect(launches[0]?.sessionName).toBe("ai-servant-t17");
    expect(launches[0]?.prompt).toContain("port the parser");
  });
});

describe("read-only delegation cannot write, which is why it needs no confirmation", () => {
  test("a research session is spawned in a permission mode that cannot edit", async () => {
    const { actions, launches } = fakeWorld();

    await actions.delegate({ task: "how does the parser work", label: "parser q", readOnly: true });

    expect(launches[0]?.permissionMode).toBe("plan");
  });

  test("work that changes things runs with the session's normal permissions", async () => {
    const { actions, launches } = fakeWorld();

    await actions.delegate({ task: "port the parser", label: "parser port", readOnly: false });

    expect(launches[0]?.permissionMode).toBeUndefined();
  });

  test("a research prompt says it is read-only, so the session reports instead of proposing edits", () => {
    const prompt = composeDelegationPrompt({
      workspace: "ai_servant",
      hubRepo: "acme/hub",
      sessionName: "ai-servant-parser-q",
      request: { task: "how does the parser work", label: "parser q", readOnly: true },
    });

    expect(prompt).toContain("read-only investigation");
    expect(prompt).toContain("Do not propose to start editing");
  });
});

describe("watching a delegated session", () => {
  const HANDLE = { label: "parser port", sessionName: "ai-servant-t17", ticket: 17 };

  function transcript(overrides: Partial<ClaudeSessionMeta> = {}): ClaudeSessionMeta {
    return {
      sessionId: "0198c0de-0000-4000-8000-000000000001",
      jsonlPath: "/tmp/x.jsonl",
      launchCwd: "/tmp/ws",
      latestCwd: "/tmp/ws",
      workspaceName: "ai_servant",
      // The marker is how a transcript is tied back to the delegation that started it.
      firstUserMessage: "servant delegation: ai-servant-t17\n\nport the parser",
      lastUserMessage: null,
      lastAssistantMessage: "tokenizer swapped; running the suite now",
      model: "claude-opus-5",
      userTurns: 1,
      assistantTurns: 4,
      mtimeMs: 0,
      ...overrides,
    };
  }

  const watching = (opts: { sessions: ClaudeSessionMeta[]; live: SessionLiveness }) =>
    createSummonsActions({
      workspace: "ai_servant",
      hubRepo: "acme/hub",
      async listSessions() {
        return opts.sessions;
      },
      async liveness() {
        return opts.live;
      },
    });

  const alive = (status: string): SessionLiveness => ({
    known: true,
    session: { pid: 1, name: "ai-servant-t17", sessionId: null, cwd: "/tmp/ws", status },
  });
  const gone: SessionLiveness = { known: true, session: null };
  const unreadable: SessionLiveness = { known: false };

  test("a working session reports its progress, mid-flight", async () => {
    const actions = watching({ sessions: [transcript()], live: alive("busy") });

    expect(await actions.observe(HANDLE)).toEqual({
      status: "running",
      latest: "tokenizer swapped; running the suite now",
      turns: 4,
    });
  });

  test("a session whose tab is gone reports its conclusion", async () => {
    const actions = watching({
      sessions: [transcript({ lastAssistantMessage: "ported; two tests still fail" })],
      live: gone,
    });

    expect(await actions.observe(HANDLE)).toEqual({
      status: "finished",
      latest: "ported; two tests still fail",
      turns: 4,
    });
  });

  test("a session still open but no longer working has finished — alive is not working", async () => {
    const actions = watching({ sessions: [transcript()], live: alive("idle") });

    expect((await actions.observe(HANDLE)).status).toBe("finished");
  });

  test("a session that has said nothing yet is running, not finished", async () => {
    const actions = watching({
      sessions: [transcript({ assistantTurns: 0, lastAssistantMessage: null })],
      live: alive("busy"),
    });

    expect((await actions.observe(HANDLE)).status).toBe("running");
  });

  test("another session's transcript is not mistaken for this one's", async () => {
    const actions = watching({
      sessions: [transcript({ firstUserMessage: "servant delegation: ai-servant-t99" })],
      live: gone,
    });

    expect(await actions.observe(HANDLE)).toEqual({ status: "unknown", latest: null, turns: 0 });
  });

  test("a freshly launched session with no transcript yet still reads as running", async () => {
    const actions = watching({ sessions: [], live: alive("busy") });

    expect((await actions.observe(HANDLE)).status).toBe("running");
  });

  test("a host that cannot report liveness says unknown, never finished", async () => {
    // Reading "no registry" as "it ended" would free the repo and put a second session in the
    // same worktree — the collision addressable sessions exist to prevent.
    const actions = watching({ sessions: [transcript()], live: unreadable });

    const report = await actions.observe(HANDLE);
    expect(report.status).toBe("unknown");
    // What it last said is still worth reporting; only the verdict on whether it stopped is withheld.
    expect(report.latest).toBe("tokenizer swapped; running the suite now");
  });
});
