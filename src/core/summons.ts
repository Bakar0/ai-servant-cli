// A Summons: a live spoken conversation with a servant workspace. The controller here is the
// single seam the feature is tested at — the Realtime socket, the sox audio pipes and the
// filesystem all sit outside it as injected ports (see workspace ADR 0009).

import { classifyConfirmation } from "./summons-confirm.ts";

/** Default Realtime model. Native speech-to-speech, so there is no STT/TTS pipeline in the path. */
export const DEFAULT_SUMMONS_MODEL = "gpt-realtime";
export const DEFAULT_SUMMONS_VOICE = "marin";

/**
 * A function tool offered to the Summons agent (JSON Schema parameters, as the Realtime API wants).
 */
export interface SummonsTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The Summons agent's entire tool surface. Every one of these is a silent, non-Guarded local read:
 * there is deliberately no edit, write or run-command tool here, and there never will be — heavy
 * and state-changing work is delegated to a Claude session instead (workspace ADR 0009).
 */
export const SUMMONS_TOOLS: readonly SummonsTool[] = [
  {
    name: "read_file",
    description:
      "Read a file from the session's scope and return its contents. Use this to answer questions about what a file says.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the session's scope root." },
      },
      required: ["path"],
    },
  },
  {
    name: "glob",
    description: "Find files in the session's scope by name pattern (e.g. `docs/**/*.md`).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to the scope root." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search the contents of files in the session's scope for a regular expression.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        glob: {
          type: "string",
          description: "Optional glob narrowing which files are searched.",
        },
      },
      required: ["pattern"],
    },
  },
];

/**
 * The Guarded half of the tool surface: handing work to a Claude session, and reading back how it
 * is going. `delegate` is only ever *proposed* by the model — the controller holds it until the
 * user says yes out loud, so a model that emits this call cannot cause execution on its own.
 */
export const DELEGATION_TOOLS: readonly SummonsTool[] = [
  {
    name: "delegate",
    description:
      "Hand a heavy or state-changing task — research, editing, multi-step work, running anything — to a fresh Claude session that does it with its full harness. Research counts as heavy: delegate it rather than reading your way to an answer. Calling this launches NOTHING: it asks the user to confirm out loud first, and their spoken answer decides.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The task, written as an instruction to a capable engineer who cannot hear this conversation. Full sentences, all the specifics the user gave.",
        },
        label: {
          type: "string",
          description:
            'Two or three words naming this piece of work, so the user can ask about it later ("the auth refactor").',
        },
        ticket: {
          type: "integer",
          description: "Hub issue number this work carries, when it has one.",
        },
        repo: {
          type: "string",
          description:
            "Mounted repo under repos/ the work touches, when it touches one. Two tasks on the same repo are run one after another, since they share a worktree.",
        },
      },
      required: ["task", "label"],
    },
  },
  {
    name: "check_delegation",
    description:
      "Read how delegated work is going — its progress while it runs, its conclusion once it has finished. A silent read: never ask permission before calling it.",
    parameters: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description:
            "Which delegated task to check. Omit only when there is just one; with several, ask the user which they mean rather than guessing.",
        },
      },
    },
  },
];

/** What the user asked for, once the agent has written it down as an instruction. */
export interface DelegationRequest {
  task: string;
  label: string;
  ticket?: number | undefined;
  repo?: string | undefined;
  /**
   * The conversation the request came out of, so the session starts informed rather than from one
   * decontextualised sentence. Becomes a pointer to the Call log once that exists (majordomo#28).
   */
  conversation?: string | undefined;
}

/** A launched delegation, addressable by the name its session runs under. */
export interface DelegationHandle {
  label: string;
  /** `<workspace>-t<ticket>` for ticketed work — computable from the ticket alone (ADR 0010). */
  sessionName: string;
  ticket?: number | undefined;
  repo?: string | undefined;
}

export type DelegationStatus = "running" | "finished" | "unknown";

export interface DelegationReport {
  status: DelegationStatus;
  /** The session's most recent word: its progress while running, its conclusion once finished. */
  latest: string | null;
  /** Exchanges so far — enough for the agent to say whether it has barely started or is deep in. */
  turns: number;
}

/**
 * Everything a Summons can do that is not a local read. Injected, so the confirm-gate and the
 * dispatch discipline are tested against fakes with no tabs, no `gh` and no clock.
 */
export interface SummonsActions {
  /** Spawn the session *and* claim its ticket — one step, so nothing ever runs unclaimed. */
  delegate(request: DelegationRequest): Promise<DelegationHandle>;
  observe(handle: DelegationHandle): Promise<DelegationReport>;
}

/** Everything the transport needs to open a Realtime session. */
export interface RealtimeSessionSpec {
  model: string;
  voice: string;
  instructions: string;
  tools: readonly SummonsTool[];
}

/** The subset of Realtime server events the controller acts on. */
export type RealtimeInbound =
  | { type: "audio"; pcm: string }
  /** The server's voice-activity detection heard the user start talking. */
  | { type: "user_speaking"; itemId?: string | undefined }
  /**
   * What the user actually said, once the server finished transcribing it. `itemId` identifies the
   * utterance, which matters for the confirm-gate: transcription lags, so an utterance can be
   * transcribed *after* the reply it provoked, and the gate must not read it as an answer.
   */
  | { type: "user_transcript"; text: string; itemId?: string | undefined }
  /** The socket went away — the session cannot continue. */
  | { type: "closed" }
  | { type: "tool_call"; callId: string; name: string; args: string }
  | { type: "assistant_transcript"; text: string }
  | { type: "error"; message: string };

export interface RealtimeTransport {
  connect(
    spec: RealtimeSessionSpec,
    onInbound: (event: RealtimeInbound) => Promise<void>,
  ): Promise<void>;
  /** Append captured mic audio (base64 PCM16) to the model's input buffer. */
  sendAudio(pcm: string): void;
  sendToolResult(callId: string, output: string): void;
  /**
   * Put a note from the controller into the conversation, for things the agent must say that no
   * tool call is waiting on — above all the verdict of the confirm-gate, which the controller
   * decides after the tool call has already been answered.
   */
  sendAgentNote(text: string): void;
  close(): Promise<void>;
}

/**
 * Microphone and speaker. Capture is an open mic — the controller never gates it on a keypress, so
 * the keyboard stays free; the model's own voice-activity detection decides when a turn ends.
 */
export interface AudioPort {
  startCapture(onChunk: (pcm: string) => void): Promise<void>;
  play(pcm: string): void;
  stop(): Promise<void>;
}

/** The clock the session runs on; injectable so tests drive time instead of waiting on it. */
export interface TimerPort {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: TimerPort = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A WebSocket Realtime session has no echo cancellation, so an open mic hears the reply coming out
 * of the speakers. The model's own voice then trips its server-side voice detection, it interrupts
 * itself after a word or two, and the conversation dies chewing on its own echo. The session is
 * therefore half-duplex: the mic is held back until the queued reply has finished playing.
 * Headphones make this moot, but it cannot be a requirement.
 */
const PLAYBACK_TAIL_MS = 400;
const PCM16_BYTES_PER_MS = (24_000 * 2) / 1000;

/** How long a base64 PCM16 chunk takes to play, in milliseconds. */
function playbackDurationMs(base64Pcm: string): number {
  const padding = base64Pcm.endsWith("==") ? 2 : base64Pcm.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, (base64Pcm.length / 4) * 3 - padding);
  return bytes / PCM16_BYTES_PER_MS;
}

/** Default silence window before a Summons hangs itself up, so a forgotten mic stops billing. */
export const DEFAULT_SUMMONS_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/** Local, read-only access to whatever the Summons is scoped to. */
export interface WorkspaceReader {
  readFile(path: string): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, options: { glob?: string | undefined }): Promise<string[]>;
}

export interface SummonsSessionOptions {
  transport: RealtimeTransport;
  reader: WorkspaceReader;
  /** Omitted, the session can still talk and read — it just has nothing to delegate work to. */
  actions?: SummonsActions | undefined;
  audio?: AudioPort | undefined;
  instructions: string;
  model?: string | undefined;
  voice?: string | undefined;
  /** Silence window before the session hangs up. 0 (or negative) keeps it open indefinitely. */
  idleTimeoutMs?: number | undefined;
  timers?: TimerPort | undefined;
  /** Fires once when the session ends — including when it hangs itself up on silence. */
  onStopped?: (() => void) | undefined;
  /** Called with anything the API reports going wrong, so the user isn't left talking to silence. */
  onError?: ((message: string) => void) | undefined;
}

export interface SummonsSession {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function requireString(args: Record<string, unknown>, key: string, tool: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${tool} needs a non-empty "${key}" argument.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseArgs(raw: string, tool: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not JSON");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse the arguments to ${tool}.`);
  }
}

async function runTool(
  reader: WorkspaceReader,
  name: string,
  rawArgs: string,
): Promise<Record<string, unknown>> {
  const args = parseArgs(rawArgs, name);
  switch (name) {
    case "read_file":
      return { content: await reader.readFile(requireString(args, "path", name)) };
    case "glob":
      return { matches: await reader.glob(requireString(args, "pattern", name)) };
    case "grep":
      return {
        matches: await reader.grep(requireString(args, "pattern", name), {
          glob: optionalString(args, "glob"),
        }),
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** How much of the conversation a delegated session is handed, so it starts informed. */
const CONVERSATION_MEMORY_TURNS = 12;

interface TrackedDelegation {
  /** The label lives on the request alone, so it cannot drift from what was delegated. */
  request: DelegationRequest;
  /** null while the delegation is queued behind another on the same repo. */
  handle: DelegationHandle | null;
  /** Set once the session has been observed to have finished, which frees its repo. */
  finished: boolean;
  queuedBehind: string | null;
}

/** Compare labels the way a person says them — case, punctuation and "the" do not count. */
function labelKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function labelMatches(tracked: string, wanted: string): boolean {
  const a = labelKey(tracked);
  const b = labelKey(wanted);
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * The Guarded half of the controller: it holds a proposed delegation until the user says yes out
 * loud, tracks what has been handed out, and keeps two tasks on one repo from running at once.
 *
 * The gate lives here, and not in the agent's instructions, for the reason the whole design turns
 * on: a model that decides its own confirmations has not been gated at all.
 */
function createDelegations(opts: SummonsSessionOptions) {
  const actions = opts.actions;
  const tracked: TrackedDelegation[] = [];
  const conversation: string[] = [];
  let pending: { request: DelegationRequest; askedAfterItemId: string | null } | null = null;

  const labelOf = (t: TrackedDelegation) => t.request.label;
  const labels = () => tracked.map(labelOf);

  function remember(who: "user" | "servant", text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    conversation.push(`${who}: ${trimmed}`);
    if (conversation.length > CONVERSATION_MEMORY_TURNS) conversation.shift();
  }

  /** Unique labels keep "check on the refactor" resolvable when a task is delegated twice. */
  function uniqueLabel(wanted: string): string {
    const taken = (candidate: string) =>
      tracked.some((t) => labelKey(labelOf(t)) === labelKey(candidate));
    if (!taken(wanted)) return wanted;
    for (let n = 2; ; n++) {
      const candidate = `${wanted} ${n}`;
      if (!taken(candidate)) return candidate;
    }
  }

  /** The delegation currently occupying a repo, if any — the one a new task must wait behind. */
  function occupant(repo: string): TrackedDelegation | null {
    return tracked.find((t) => t.request.repo === repo && t.handle && !t.finished) ?? null;
  }

  async function start(entry: TrackedDelegation): Promise<void> {
    if (!actions) throw new Error("This Summons has nothing to delegate to.");
    entry.handle = await actions.delegate(entry.request);
    entry.queuedBehind = null;
  }

  /**
   * What is still holding a repo, or null if nothing is. Pull-shaped by design: nothing watches,
   * so the question is asked at the two moments its answer changes what happens — when new work
   * arrives for the repo, and when anyone asks after a delegation on it.
   *
   * Only a positive "finished" frees the repo. `unknown` — an unreadable session registry, say —
   * must not, or two sessions end up in one worktree, which is the collision this exists to stop.
   */
  async function blocker(repo: string): Promise<TrackedDelegation | null> {
    const busy = occupant(repo);
    if (!busy?.handle || !actions) return null;
    const report = await actions.observe(busy.handle);
    if (report.status !== "finished") return busy;
    busy.finished = true;
    return null;
  }

  /** Launch, unless the repo is busy — same repo means the same worktree, so they cannot overlap. */
  async function launchOrQueue(
    entry: TrackedDelegation,
  ): Promise<{ started: true } | { started: false; behind: string }> {
    const repo = entry.request.repo;
    const busy = repo ? await blocker(repo) : null;
    if (busy) {
      entry.queuedBehind = labelOf(busy);
      return { started: false, behind: labelOf(busy) };
    }
    await start(entry);
    return { started: true };
  }

  /** Start whatever was waiting on a repo, if that repo has since come free. */
  async function drain(repo: string | undefined): Promise<string | null> {
    if (!repo || (await blocker(repo))) return null;
    const next = tracked.find((t) => t.request.repo === repo && !t.handle && !t.finished);
    if (!next) return null;
    await start(next);
    return labelOf(next);
  }

  return {
    remember,

    /**
     * Hold a proposed delegation. Nothing is launched here, and nothing can be — this does no I/O
     * at all; the request is put aside and the agent is told to go and ask. `lastUserItemId` marks
     * the utterance that *caused* this proposal, so a late transcript of it is not mistaken for
     * the answer to it.
     */
    propose(callId: string, rawArgs: string, lastUserItemId: string | null): void {
      const answer = (payload: Record<string, unknown>) =>
        opts.transport.sendToolResult(callId, JSON.stringify(payload));
      if (!actions) {
        answer({
          error: "This Summons cannot delegate — it was started without workspace actions.",
        });
        return;
      }
      if (pending) {
        answer({
          error: `"${pending.request.label}" is already waiting on a yes or no. Get an answer to that first.`,
        });
        return;
      }
      let request: DelegationRequest;
      try {
        const args = parseArgs(rawArgs, "delegate");
        request = {
          task: requireString(args, "task", "delegate"),
          label: uniqueLabel(requireString(args, "label", "delegate")),
          ticket: optionalPositiveInteger(args, "ticket"),
          repo: optionalString(args, "repo"),
          conversation: conversation.length > 0 ? conversation.join("\n") : undefined,
        };
      } catch (err) {
        answer({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      pending = { request, askedAfterItemId: lastUserItemId };
      answer({
        status: "awaiting_confirmation",
        launched: false,
        label: request.label,
        instruction:
          "Nothing has been launched. Say out loud, in one sentence, what you are about to hand to Claude, then ask the user to answer yes or no. Do not call delegate again — their spoken answer is what decides.",
      });
    },

    /**
     * The user has spoken while a delegation is held. Only an unambiguous yes releases it; a no and
     * anything unclear both decline, because a misheard sentence must never launch runaway work.
     * Returns false when the utterance was not an answer at all (the request itself, transcribed
     * late), leaving the gate held.
     */
    async resolve(text: string, itemId: string | null): Promise<boolean> {
      const held = pending;
      if (!held) return false;
      if (itemId && itemId === held.askedAfterItemId) return false;
      pending = null;

      const verdict = classifyConfirmation(text);
      if (verdict === "negative") {
        opts.transport.sendAgentNote(
          `The user declined "${held.request.label}". Nothing was launched. Acknowledge briefly and move on.`,
        );
        return true;
      }
      if (verdict === "unclear") {
        opts.transport.sendAgentNote(
          `That was not a clear yes, so "${held.request.label}" was NOT launched. Ask again for a plain yes or no.`,
        );
        return true;
      }

      const entry: TrackedDelegation = {
        request: held.request,
        handle: null,
        finished: false,
        queuedBehind: null,
      };
      tracked.push(entry);
      try {
        const outcome = await launchOrQueue(entry);
        opts.transport.sendAgentNote(
          outcome.started
            ? `Launched "${labelOf(entry)}" in a Claude session (${entry.handle?.sessionName}). Tell the user it is running and that they can ask how it is going.`
            : `"${labelOf(entry)}" is queued behind "${outcome.behind}" — they touch the same repo, so they cannot run at once. Tell the user it will start when that one finishes.`,
        );
      } catch (err) {
        tracked.pop();
        opts.transport.sendAgentNote(
          `Launching "${labelOf(entry)}" failed: ${err instanceof Error ? err.message : String(err)}. Nothing is running. Tell the user plainly.`,
        );
      }
      return true;
    },

    /** Silent, and never gated — observing changes nothing, so nothing is confirmed. */
    async observe(rawArgs: string): Promise<Record<string, unknown>> {
      if (!actions || tracked.length === 0) {
        return { error: "Nothing has been delegated in this conversation yet." };
      }
      const wanted = optionalString(parseArgs(rawArgs, "check_delegation"), "label");
      // An exact label wins outright, so "the api research 2" resolves rather than colliding with
      // "the api research" it was disambiguated from. Otherwise a loose match, then ask.
      const exact = wanted ? tracked.filter((t) => labelKey(labelOf(t)) === labelKey(wanted)) : [];
      const matches =
        exact.length === 1
          ? exact
          : wanted
            ? tracked.filter((t) => labelMatches(labelOf(t), wanted))
            : tracked;
      if (matches.length === 0) {
        return { error: `No delegated work called "${wanted}".`, delegations: labels() };
      }
      if (matches.length > 1) {
        // Asking is the whole point: picking one would report on work the user did not mean.
        return {
          needs_disambiguation: true,
          delegations: matches.map(labelOf),
          instruction: "Ask the user which of these they mean. Do not guess.",
        };
      }
      const entry = matches[0] as TrackedDelegation;
      // Asking after a queued task is the other moment its repo might have come free, so this is
      // where it gets to start — otherwise it would wait on someone happening to ask about the
      // delegation ahead of it instead.
      if (!entry.handle && entry.request.repo) await drain(entry.request.repo);
      if (!entry.handle) {
        const ahead = entry.request.repo ? occupant(entry.request.repo) : null;
        return {
          label: labelOf(entry),
          status: "queued",
          queued_behind: ahead ? labelOf(ahead) : entry.queuedBehind,
          task: entry.request.task,
        };
      }
      const report = await actions.observe(entry.handle);
      let alsoStarted: string | null = null;
      if (report.status === "finished" && !entry.finished) {
        entry.finished = true;
        alsoStarted = await drain(entry.request.repo);
      }
      return {
        label: labelOf(entry),
        session: entry.handle.sessionName,
        status: report.status,
        turns: report.turns,
        latest: report.latest,
        ...(alsoStarted ? { also_started: alsoStarted } : {}),
      };
    },
  };
}

export function createSummonsSession(opts: SummonsSessionOptions): SummonsSession {
  const timers = opts.timers ?? realTimers;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_SUMMONS_IDLE_TIMEOUT_MS;
  const delegations = createDelegations(opts);
  let idleHandle: unknown = null;
  let stopped = false;
  /** When the audio queued so far will have finished playing out of the speakers. */
  let speakingUntil = 0;
  /** The utterance the server is currently hearing — the gate's evidence of what came from where. */
  let lastUserItemId: string | null = null;

  // Tool failures are conversation, not crashes: the agent hears what went wrong and can say so.
  async function handleToolCall(call: Extract<RealtimeInbound, { type: "tool_call" }>) {
    // `delegate` is the one call that gets no answer here: it is Guarded, so it is held and
    // answered from inside the gate, and it never reaches an action on the strength of this event.
    if (call.name === "delegate") {
      delegations.propose(call.callId, call.args, lastUserItemId);
      return;
    }
    let result: Record<string, unknown>;
    try {
      result =
        call.name === "check_delegation"
          ? await delegations.observe(call.args)
          : await runTool(opts.reader, call.name, call.args);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    opts.transport.sendToolResult(call.callId, JSON.stringify(result));
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    timers.clearTimeout(idleHandle);
    idleHandle = null;
    await opts.audio?.stop();
    await opts.transport.close();
    opts.onStopped?.();
  }

  function markActive(): void {
    if (stopped || idleTimeoutMs <= 0) return;
    timers.clearTimeout(idleHandle);
    idleHandle = timers.setTimeout(() => void stop(), idleTimeoutMs);
  }

  async function handleInbound(event: RealtimeInbound): Promise<void> {
    markActive();
    switch (event.type) {
      case "tool_call":
        await handleToolCall(event);
        return;
      case "audio":
        speakingUntil = Math.max(speakingUntil, timers.now()) + playbackDurationMs(event.pcm);
        opts.audio?.play(event.pcm);
        return;
      case "error":
        opts.onError?.(event.message);
        return;
      case "closed":
        await stop();
        return;
      case "user_speaking":
        lastUserItemId = event.itemId ?? null;
        return;
      case "user_transcript":
        // The one place a spoken word decides something: releasing a held delegation.
        await delegations.resolve(event.text, event.itemId ?? null);
        delegations.remember("user", event.text);
        return;
      case "assistant_transcript":
        delegations.remember("servant", event.text);
        return;
      default:
        return;
    }
  }

  return {
    async start() {
      await opts.transport.connect(
        {
          model: opts.model || DEFAULT_SUMMONS_MODEL,
          voice: opts.voice || DEFAULT_SUMMONS_VOICE,
          instructions: opts.instructions,
          // Offered only when there is something to delegate to, so the agent is never holding a
          // tool that cannot work.
          tools: opts.actions ? [...SUMMONS_TOOLS, ...DELEGATION_TOOLS] : SUMMONS_TOOLS,
        },
        handleInbound,
      );
      // The socket can die inside either await above — a rejected key, for instance, is reported
      // and closed after the handshake succeeds. Re-check both times, or a mic opened after stop()
      // is a sox subprocess nobody owns and the session never exits.
      if (stopped) return;
      // Deliberately no markActive() in the capture callback: an open mic streams PCM frames
      // through silence too, so counting them as activity would mean the idle hang-up never fires.
      // Only what the server reports — speech, a reply, a tool call — proves the conversation lives.
      await opts.audio?.startCapture((pcm) => {
        if (timers.now() < speakingUntil + PLAYBACK_TAIL_MS) return;
        opts.transport.sendAudio(pcm);
      });
      if (stopped) {
        await opts.audio?.stop();
        return;
      }
      markActive();
    },
    stop,
  };
}
