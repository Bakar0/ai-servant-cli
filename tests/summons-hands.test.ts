// The outside of the hands seam, asserted against a fake headless runner — no `claude`, no spawn,
// no session store. What is being tested is the argv, the thread, and the lifetime.

import { describe, expect, test } from "bun:test";
import { handsSessionName } from "../src/core/session-name.ts";
import { type HandsRun, createHandsSession } from "../src/core/summons-hands.ts";

function hands(answer: (run: HandsRun, index: number) => string | Promise<string> = () => "ok") {
  const runs: HandsRun[] = [];
  const registered: string[] = [];
  let n = 0;
  const session = createHandsSession({
    workspace: "ai_servant",
    cwd: "/tmp/ws",
    runner: async (run) => {
      runs.push(run);
      return answer(run, runs.length - 1);
    },
    newSessionId: () => `session-${++n}`,
    // Injected, so asserting the argv never writes to servant's real cache.
    register: async (id) => {
      registered.push(id);
    },
  });
  return { session, runs, registered };
}

const flag = (argv: readonly string[], name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

/** What the session was actually asked — the positional prompt `-p` carries. */
const promptOf = (run: HandsRun | undefined) => flag(run?.argv ?? [], "-p") ?? "";

/** Let a queued request reach the runner. Requests are serialized, so starting takes a turn. */
const inFlight = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("naming the Hands session", () => {
  test("one per workspace, computable without searching for it", () => {
    expect(handsSessionName("ai_servant")).toBe("ai-servant-hands");
  });
});

describe("reaching the Hands session", () => {
  test("nothing is spawned until something actually needs hands", async () => {
    const { runs } = hands();
    expect(runs).toEqual([]);
  });

  test("the first request spawns it, named so it can be addressed later", async () => {
    const { session, runs } = hands();

    await session.ask("run the unit tests");

    expect(runs).toHaveLength(1);
    expect(flag(runs[0]?.argv ?? [], "--name")).toBe("ai-servant-hands");
    expect(flag(runs[0]?.argv ?? [], "--session-id")).toBe("session-1");
    expect(runs[0]?.cwd).toBe("/tmp/ws");
  });

  test("the answer comes back as the answer, not as something to go and read", async () => {
    const { session } = hands(() => "3 tests failed, all in the parser");

    expect(await session.ask("run the unit tests")).toBe("3 tests failed, all in the parser");
  });

  test("later requests resume the same thread rather than starting a new one", async () => {
    const { session, runs } = hands();

    await session.ask("what does git blame say here");
    await session.ask("and the line above it");

    expect(flag(runs[1]?.argv ?? [], "--resume")).toBe("session-1");
    expect(flag(runs[1]?.argv ?? [], "--session-id")).toBe(null);
  });

  test("a request needing approval completes rather than silently producing nothing", async () => {
    const { session, runs } = hands();

    await session.ask("run the unit tests");

    expect(runs[0]?.argv).toContain("--dangerously-skip-permissions");
  });

  test("it is told what it is, once, and asked plainly after that", async () => {
    const { session, runs } = hands();

    await session.ask("run the unit tests");
    await session.ask("now run the linter");

    expect(promptOf(runs[0])).toContain("ai_servant");
    expect(promptOf(runs[0])).toContain("run the unit tests");
    expect(promptOf(runs[1])).toBe("now run the linter");
  });

  test("a run that failed is reported, not swallowed", async () => {
    const { session } = hands(() => {
      throw new Error("claude exited 1");
    });

    await expect(session.ask("run the unit tests")).rejects.toThrow("claude exited 1");
  });

  test("two requests at once do not become two sessions racing for one name", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session, runs } = hands(async (_run, index) => {
      if (index === 0) await held;
      return "ok";
    });

    const first = session.ask("run the unit tests");
    const second = session.ask("and the linter");
    await inFlight();
    expect(runs).toHaveLength(1);

    (release as unknown as () => void)();
    await Promise.all([first, second]);

    expect(flag(runs[0]?.argv ?? [], "--session-id")).toBe("session-1");
    expect(flag(runs[1]?.argv ?? [], "--resume")).toBe("session-1");
    expect(flag(runs[1]?.argv ?? [], "--session-id")).toBe(null);
  });

  test("the session it starts is servant's own, not one of the user's to be measured", async () => {
    const { session, registered } = hands();

    await session.ask("run the unit tests");
    await session.ask("now the linter");

    expect(registered).toEqual(["session-1"]);
  });

  test("a first run that failed leaves no thread to resume — the next one starts over", async () => {
    const { session, runs } = hands((_run, index) => {
      if (index === 0) throw new Error("claude exited 1");
      return "ok";
    });

    await session.ask("run the unit tests").catch(() => {});
    await session.ask("try that again");

    expect(flag(runs[1]?.argv ?? [], "--session-id")).toBe("session-2");
    expect(flag(runs[1]?.argv ?? [], "--resume")).toBe(null);
  });
});

describe("the Hands session ends with the Summons", () => {
  test("ending one that never started runs nothing", async () => {
    const { session, runs } = hands();

    await session.end();

    expect(runs).toEqual([]);
  });

  test("a request in flight when the Summons hangs up is aborted", async () => {
    const { session, runs } = hands(
      (run) =>
        new Promise<string>((_resolve, reject) => {
          run.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const pending = session.ask("run the whole suite");
    await inFlight();
    await session.end();

    await expect(pending).rejects.toThrow("aborted");
    expect(runs[0]?.signal.aborted).toBe(true);
  });

  test("asking an ended Hands session is refused rather than quietly reviving it", async () => {
    const { session, runs } = hands();

    await session.ask("run the unit tests");
    await session.end();

    await expect(session.ask("one more thing")).rejects.toThrow(/ended/i);
    expect(runs).toHaveLength(1);
  });
});
