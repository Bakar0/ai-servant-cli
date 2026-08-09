// The outside of the hands seam: what actually happens when the Summons agent asks its Hands
// session for something. Spawning, resuming and the subprocess all live here, so the controller's
// lazy-start and lifetime discipline can be tested against a fake runner with no `claude` anywhere
// near it (workspace ADR 0009).
//
// The channel is a *synchronous headless call* — `claude -p`, one request and one response, keeping
// its thread across calls with `--resume`. The alternative, posting to the session's inbox socket,
// was rejected in ADR 0010: undocumented wire format, and no return path at all, so "does it
// compile?" would have needed a second mechanism to answer.
//
// Claude only, and deliberately not routed through the `AgentBackend` headless seam the extraction
// and judgment passes use. That seam's contract is a one-shot run; a Hands session is defined by a
// *resumable* headless thread, which is `--session-id` then `--resume`. Codex has neither — its
// headless runs are `--ephemeral` precisely so they leave no session to resume — so there is no
// second implementation to abstract over, only a shape to invent. A Codex workspace summons
// without hands rather than being handed a contract that cannot hold (ADR 0010, decision 6).

import { registerHeadlessSession } from "./headless-sessions.ts";
import { workspacePath } from "./paths.ts";
import { handsSessionName } from "./session-name.ts";
import type { HandsPort } from "./summons.ts";

/** One headless run: everything the runner needs, and the abort that ends it early. */
export interface HandsRun {
  argv: string[];
  cwd: string;
  /** Aborted when the Summons hangs up, so a long job does not outlive the conversation. */
  signal: AbortSignal;
}

/** Runs one headless call and returns what the session replied. Injected in tests. */
export type HandsRunner = (run: HandsRun) => Promise<string>;

export interface HandsSessionDeps {
  workspace: string;
  /** Where the session runs. Defaults to the workspace root, which is what it is hands for. */
  cwd?: string | undefined;
  runner?: HandsRunner | undefined;
  /** Injected in tests; the real one is a UUID, which is what `--session-id` takes. */
  newSessionId?: (() => string) | undefined;
  /** Injected in tests, so asserting the argv does not write to servant's real cache. */
  register?: ((sessionId: string) => Promise<void>) | undefined;
}

/**
 * The first thing the Hands session ever reads. It says what it is and who is waiting, because
 * nobody is watching this session: there is no tab to notice it asking a question into the void,
 * so it has to be told to answer rather than to check.
 */
export function composeHandsPrompt(workspace: string, request: string): string {
  return [
    `You are the hands of a spoken Summons of the "${workspace}" servant workspace.`,
    "A voice agent is talking with the user out loud. It can read and search, but it cannot run or change anything — so it hands you the small jobs it needs the result of: run the tests, check whether that compiles, see what git blame says.",
    "Your reply is read back to the user out loud, so lead with the answer and keep it to a few sentences. Nobody is watching this session and you cannot ask anything: if a job needs a decision that is not yours, do what you safely can and say what you stopped at.",
    "This session carries no ticket and holds no Claim on one. Work at that scale gets a session of its own — if a request turns out to be that, say so rather than starting it.",
    `## Request\n\n${request}`,
  ].join("\n\n");
}

/**
 * Argv for one headless call. The first carries `--session-id` and `--name`, which is what makes
 * the thread resumable and the session addressable; every call after it carries `--resume` instead.
 *
 * `--dangerously-skip-permissions` is the deliberate widening reasoned through in ADR 0010: a `-p`
 * session cannot prompt, so anything needing approval would be auto-denied and the job would come
 * back having silently done nothing. During a Summons the user is away from the keyboard, so a
 * prompt in a session with no tab protects nobody either — it stalls instead of denying. The Call
 * log is the compensating control, which is why it had to exist first.
 *
 * No `--model`: `headlessModelArgs()` is for the servant's own housekeeping passes, whose spend is
 * the servant's (ADR 005). This is the user's work asked for out loud, so it inherits the user's
 * default model exactly as a spawned tab does.
 */
export function handsArgv(
  prompt: string,
  session: { id: string; name: string; started: boolean },
): string[] {
  return [
    "claude",
    "-p",
    prompt,
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    ...(session.started
      ? ["--resume", session.id]
      : ["--session-id", session.id, "--name", session.name]),
  ];
}

const defaultRunner: HandsRunner = async (run) => {
  const proc = Bun.spawn(run.argv, {
    cwd: run.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const kill = () => proc.kill();
  run.signal.addEventListener("abort", kill, { once: true });
  try {
    // Both pipes are drained alongside the exit, never after it. "Run the whole test suite" is one
    // of the jobs this exists for, and a child that fills a pipe nobody is reading blocks forever
    // — which would look from the outside exactly like Claude thinking.
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (run.signal.aborted) throw new Error("The Summons ended before the answer came back.");
    if (code !== 0) {
      throw new Error(`The Hands session exited ${code}: ${err.trim().slice(0, 200)}`);
    }
    return out.trim();
  } finally {
    run.signal.removeEventListener("abort", kill);
  }
};

/**
 * One Hands session for one Summons. Nothing is spawned here — the session starts on the first
 * request that actually needs it, because most conversations never need one at all.
 */
export function createHandsSession(deps: HandsSessionDeps): HandsPort {
  const runner = deps.runner ?? defaultRunner;
  const newSessionId = deps.newSessionId ?? (() => crypto.randomUUID());
  const register = deps.register ?? registerHeadlessSession;
  const cwd = deps.cwd ?? workspacePath(deps.workspace);
  const name = handsSessionName(deps.workspace);
  const ending = new AbortController();
  /** null until the first request has come back — a run that never landed left no thread. */
  let threadId: string | null = null;
  let ended = false;
  /**
   * Requests run one at a time. The Realtime transport dispatches inbound events without waiting
   * on the last one, so two `ask_hands` calls can overlap — and two overlapping calls on one
   * session are two `--session-id`s racing for one name, or two `--resume`s on one thread.
   */
  let queue: Promise<unknown> = Promise.resolve();

  async function run(request: string): Promise<string> {
    if (ended) throw new Error("The Hands session has ended with the Summons that owned it.");
    const started = threadId !== null;
    const id = threadId ?? newSessionId();
    // Registered before it is spawned, and best-effort: a Hands session is servant's own headless
    // work, not one of the user's sessions, so it must not be measured as one — but failing to
    // register is no reason to refuse the job the user asked for out loud.
    if (!started) await register(id).catch(() => {});
    const answer = await runner({
      argv: handsArgv(started ? request : composeHandsPrompt(deps.workspace, request), {
        id,
        name,
        started,
      }),
      cwd,
      signal: ending.signal,
    });
    // Only a call that came back proves there is a thread to resume: resuming an id whose first
    // run died before writing a transcript fails, and would fail on every request after it.
    threadId = id;
    return answer;
  }

  return {
    ask(request: string): Promise<string> {
      const answer = queue.then(() => run(request));
      // The queue is swallowed on its own account, so one failed request cannot poison every
      // request after it — and so the chain above needs no rejection handler.
      queue = answer.catch(() => {});
      return answer;
    },

    // Nothing to shut down when the session was never started: a headless call is a subprocess per
    // request, not a daemon, so ending is refusing the next one and killing the one in flight —
    // which is what keeps a hang-up from leaving a job running for nobody. Synchronous, and it
    // stays that way: the Summons awaits this on its way out, and a hang-up must not be able to
    // block on the job it is cancelling.
    end(): Promise<void> {
      if (!ended) {
        ended = true;
        ending.abort();
      }
      return Promise.resolve();
    },
  };
}
