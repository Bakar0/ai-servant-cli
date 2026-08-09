// The outside of the hands seam, asserted against a fake headless runner — no `claude`, no spawn,
// no session store. What is being tested is the argv, the thread, and the lifetime.

import { describe, expect, test } from "bun:test";
import { handsSessionName } from "../src/core/session-name.ts";
import { type HandsRun, createHandsSession } from "../src/core/summons-hands.ts";

function hands(
  answer: (run: HandsRun, index: number) => string | Promise<string> = () => "ok",
  timeoutMs?: number,
) {
  const runs: HandsRun[] = [];
  const registered: string[] = [];
  let n = 0;
  const session = createHandsSession({
    workspace: "ai_servant",
    cwd: "/tmp/ws",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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

  test("it is told its own commands are headless, so it does not reach for a picker", async () => {
    const { session, runs } = hands();

    await session.ask("what sessions are running");

    // The exact trap that hung a live Summons: it ran `servant resume`, whose picker cannot be
    // answered from a headless child, and never came back.
    expect(promptOf(runs[0])).toContain("servant resume");
    expect(promptOf(runs[0])).toMatch(/no stdin|headless|hang/i);
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

describe("a request that will not come back", () => {
  /** A run that never resolves, and reports whether it was aborted. */
  const neverAnswers = (run: HandsRun) =>
    new Promise<string>((_resolve, reject) => {
      run.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });

  test("is given up on, and says so in words the agent can read out", async () => {
    const { session } = hands(neverAnswers, 5);

    // The failure this closes: with no deadline, the agent could only keep saying "just a moment".
    await expect(session.ask("run the whole suite")).rejects.toThrow(/still working|stopped/i);
  });

  test("is killed, not merely abandoned to keep running for nobody", async () => {
    const { session, runs } = hands(neverAnswers, 5);

    await session.ask("run the whole suite").catch(() => {});

    expect(runs[0]?.signal.aborted).toBe(true);
  });

  test("leaves the Hands session usable, rather than poisoning every request after it", async () => {
    let first = true;
    const { session } = hands((run) => {
      if (!first) return "all green";
      first = false;
      return neverAnswers(run);
    }, 5);

    await session.ask("run the whole suite").catch(() => {});

    expect(await session.ask("just the unit tests")).toBe("all green");
  });

  test("a timeout is told apart from the Summons hanging up", async () => {
    // A real deadline, far enough out that hanging up is unambiguously what ended this request.
    const { session } = hands(neverAnswers, 60_000);

    const pending = session.ask("run the whole suite");
    await inFlight();
    await session.end();

    await expect(pending).rejects.toThrow(/Summons ended/i);
  });

  test("keeps the thread, so the next request does not open a second session at one address", async () => {
    let first = true;
    const { session, runs } = hands((run) => {
      if (!first) return "all green";
      first = false;
      return neverAnswers(run);
    }, 5);

    await session.ask("run the whole suite").catch(() => {});
    await session.ask("just the unit tests");

    // It ran long enough to have a session on disk. Minting a second `--session-id` under the same
    // `--name` would leave two sessions at one address for the registry to choose between.
    expect(flag(runs[1]?.argv ?? [], "--resume")).toBe("session-1");
    expect(flag(runs[1]?.argv ?? [], "--session-id")).toBe(null);
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

    await expect(pending).rejects.toThrow(/Summons ended/i);
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
