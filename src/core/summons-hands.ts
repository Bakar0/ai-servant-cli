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
  /** How long one request may run. 0 (or negative) waits indefinitely. */
  timeoutMs?: number | undefined;
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
    // Learned the hard way: asked "what sessions are running", a Hands session reached for
    // `servant resume` — whose picker cannot be answered from here — and hung until the Summons
    // was killed. It knows it is unwatched; it has to be told its subprocesses are too.
    "## You are headless\n\nEvery command you run has no terminal and no stdin. Anything that prompts, pages, or opens a picker will hang until you are killed, and hanging is worse than failing: the user is left listening to silence. Never run one — no `servant resume` without an id, no `git rebase -i`, no `fzf`, no pager. Pass every flag up front, pipe anything long through `cat`, and prefer a command that prints and exits. To see what sessions are running, `servant sessions [--json]` is the one that answers and exits.",
    "## What you have\n\nThe full Claude Code harness in this workspace: reading, searching, editing, git, `gh`, and the `servant` CLI itself. This workspace's skills are available to you as slash commands — use the small ones freely when they fit the request. Anything big enough to want its own session is not yours: say so instead of starting it.",
    "This session carries no ticket and holds no Claim on one.",
    // A backstop, and deliberately not the enforcement: which session may be addressed is decided
    // in the controller before the request ever reaches here (workspace ADR 0010, decision 9 as
    // amended), because a model that decides its own scoping has not been scoped.
    "## Relaying\n\nSome requests ask you to pass an instruction to another running session. Send exactly the message you are given, to exactly the session you are named — never to another one, never reworded, and never acted on yourself. The session it is addressed to has already been checked; you are the delivery, not the decision.",
    `## Request\n\n${request}`,
  ].join("\n\n");
}

/**
 * How long a request may run before it is given up on. A Summons is a conversation: past a couple
 * of minutes the answer has stopped being worth waiting for, and the agent saying so out loud beats
 * it saying "just a moment" forever, which is what happened without this.
 */
/**
 * Politeness and request framing, stripped before a clause is read for its verb. "fix the parser"
 * and "can you fix the parser" are the same request, and the second one would otherwise read as a
 * question because it starts with "can".
 */
const REQUEST_FRAME =
  /^(?:please|kindly|can you|could you|would you|will you|i want you to|i'd like you to|i would like you to|go ahead and|go and|just|now|then|also|and|first|next|maybe)\s+/i;

/** Where a new clause begins, so "check the tests and fix the broken one" is read as two. */
const CLAUSE_SPLIT = /(?:[.;,!?]|\band\b|\bthen\b|\bafter that\b|\bonce that\b|\balso\b)+/i;

/**
 * Verbs that, said as an instruction, leave something different afterwards. Not a list of dangerous
 * words: a list of things whose *imperative* changes the world.
 */
const MUTATING_VERB =
  /^(?:edit|change|modify|fix|repair|update|upgrade|downgrade|bump|rename|refactor|rewrite|write|create|make|add|append|insert|delete|remove|drop|clear|wipe|truncate|revert|undo|restore|reset|commit|push|pull|merge|rebase|squash|amend|cherry-pick|stash|stage|tag|deploy|publish|release|install|uninstall|apply|migrate|generate|scaffold|seed|bootstrap|format|lint|prettify|replace|swap|move|mv|copy|cp|touch|mkdir|chmod|kill|stop|restart|start|enable|disable|configure|set|unset|patch|implement|build)\b/i;

/**
 * Things that change the world wherever they appear in a sentence, because they reach outside the
 * working tree and no phrasing makes them safe to do unasked.
 */
const OUTWARD_ACTION =
  /\bgit\s+(?:commit|push|merge|rebase|reset|revert|tag|cherry-pick)\b|\b(?:npm|bun|yarn|pnpm)\s+(?:install|add|remove|uninstall|publish)\b|\brm\s+-|\bgh\s+(?:pr|issue|release)\s+(?:create|merge|close|edit)\b|--fix\b/i;

/**
 * Would this hands request change something?
 *
 * The Hands session runs with `--dangerously-skip-permissions` and can edit, write and run anything
 * (see `handsArgv`). `delegate` is Guarded precisely because it changes things — so without this,
 * "ask your hands to refactor the parser" walks straight around the one gate that exists to catch
 * exactly that. It is the same hole `looksLikeStopInstruction` closes for a stop phrased as a
 * redirect, and it is closed the same way: by reading the words, deterministically, rather than
 * trusting the tool descriptions to have steered the model right.
 *
 * A heuristic, and biased on purpose — but not as hard as the stop detector is. A false positive
 * costs one spoken yes; too many of them and the user answers yes without listening, which is worse
 * than the hole. So it looks for a mutating verb where an *instruction* would put one — at the start
 * of a clause, once request framing is stripped — rather than anywhere in the sentence. "what did
 * that commit change", "why does the fix fail" and "check whether it compiles" are questions, and
 * are read as questions.
 */
export function looksLikeWritingRequest(request: string): boolean {
  const text = request.trim();
  if (!text) return false;
  if (OUTWARD_ACTION.test(text)) return true;
  return text
    .split(CLAUSE_SPLIT)
    .map((clause) => {
      let rest = clause.trim();
      // Repeatedly, because "can you please just fix it" stacks three frames.
      for (let depth = 0; depth < 4 && REQUEST_FRAME.test(rest); depth++) {
        rest = rest.replace(REQUEST_FRAME, "").trim();
      }
      return rest;
    })
    .some((clause) => MUTATING_VERB.test(clause));
}

export const DEFAULT_HANDS_TIMEOUT_MS = 2 * 60 * 1000;

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

/** How long a killed request is given to die politely before it is killed outright. */
const KILL_GRACE_MS = 2_000;

/** Rejects the moment the run is abandoned, so nothing downstream keeps waiting on the child. */
function abandoned(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const give = () => reject(new Error("The request was abandoned before it came back."));
    if (signal.aborted) give();
    else signal.addEventListener("abort", give, { once: true });
  });
}

const defaultRunner: HandsRunner = async (run) => {
  const proc = Bun.spawn(run.argv, {
    cwd: run.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    proc.kill();
    // A wedged child — or a grandchild of it still holding the pipe — would otherwise sit there
    // ignoring SIGTERM, which is the hang this deadline exists to end.
    escalation = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  };
  run.signal.addEventListener("abort", kill, { once: true });
  try {
    // Both pipes are drained alongside the exit, never after it. "Run the whole test suite" is one
    // of the jobs this exists for, and a child that fills a pipe nobody is reading blocks forever
    // — which would look from the outside exactly like Claude thinking.
    //
    // Raced against the abort rather than awaited through it: once a request has been given up on,
    // waiting for its output to close is waiting on exactly the process we stopped trusting.
    const [out, err, code] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      abandoned(run.signal),
    ]);
    if (code !== 0) {
      throw new Error(`The Hands session exited ${code}: ${err.trim().slice(0, 200)}`);
    }
    return out.trim();
  } finally {
    run.signal.removeEventListener("abort", kill);
    clearTimeout(escalation);
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
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HANDS_TIMEOUT_MS;
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
    // Two ways a request stops early, and the agent has to be able to say which out loud — so the
    // deadline is watched here rather than left to the runner, which only ever sees "aborted".
    const overdue = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) deadline = setTimeout(() => overdue.abort(), timeoutMs);
    let answer: string;
    try {
      answer = await runner({
        argv: handsArgv(started ? request : composeHandsPrompt(deps.workspace, request), {
          id,
          name,
          started,
        }),
        cwd,
        signal: AbortSignal.any([ending.signal, overdue.signal]),
      });
    } catch (err) {
      // The Summons ending is checked first: it is the answer the user is owed, and a request that
      // runs out its deadline in the same moment the call is hung up is a hang-up, not a timeout.
      if (ending.signal.aborted) {
        throw new Error("The Summons ended before the answer came back.", { cause: err });
      }
      if (overdue.signal.aborted) {
        // A request that ran long enough to time out has a session on disk, so the thread is kept
        // and the next request resumes it. Losing it would mint a second `--session-id` under the
        // same `--name`, leaving two sessions at one address for the registry to choose between.
        threadId = id;
        const seconds = Math.max(1, Math.round(timeoutMs / 1000));
        throw new Error(
          `The Hands session was still working after ${seconds} seconds, so it was stopped. Nothing it may have started was finished.`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(deadline);
    }
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
