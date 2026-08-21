// A Summons: a live spoken conversation with a servant workspace. The controller here is the
// single seam the feature is tested at — the Realtime socket, the sox audio pipes and the
// filesystem all sit outside it as injected ports (see workspace ADR 0009).

import {
  type CallLogEndReason,
  type CallLogPort,
  NULL_CALL_LOG,
  recordedText,
} from "./call-log/record.ts";
import { classifyConfirmation } from "./summons-confirm.ts";
import {
  composeSteerMessage,
  composeSteerRequest,
  looksLikeStopInstruction,
  parseSteerAck,
} from "./summons-steer.ts";

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
 * Handing work to a Claude session, and reading back how it is going.
 *
 * Only `delegate` is Guarded. It is never more than *proposed* by the model — the controller holds
 * it until the user says yes out loud, so a model that emits that call cannot cause execution on
 * its own. `research` is not gated, and does not need to be: it spawns a session in a permission
 * mode that cannot write, so the worst a misheard sentence can do is read some files and spend
 * tokens in a tab you close. What the gate protects is *change*, not effort.
 */
export const DELEGATION_TOOLS: readonly SummonsTool[] = [
  {
    name: "research",
    description:
      "Hand a question about the code — 'how does X work', 'why is Y slow', 'what calls Z' — to a fresh Claude session that can search the whole codebase, in its own tab where the user can watch it. Use this instead of grinding through files yourself: it is token-hungry work and Claude has the harness for it. Launches immediately, no confirmation, because the session it starts cannot change anything. For a fact you need before you can finish the sentence you are saying, use ask_hands, which answers into the conversation instead. If the task would edit, run or write ANYTHING, it is not research — use delegate.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The question, written out for someone who cannot hear this conversation. Say what would count as an answer.",
        },
        label: {
          type: "string",
          description:
            'Two or three words naming it, so the user can ask about it later ("the parser question").',
        },
        repo: {
          type: "string",
          description: "Mounted repo under repos/ the question is about, when it is about one.",
        },
      },
      required: ["task", "label"],
    },
  },
  {
    name: "delegate",
    description:
      "Hand work that CHANGES something — editing, refactoring, running commands, anything that writes — to a fresh Claude session with its full harness. Calling this launches NOTHING: it asks the user to confirm first, and their answer decides. For read-only questions use research instead, which needs no confirmation.",
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

/**
 * Who is working in this workspace right now. A free file read (ADR 0010 decision 3) — the Summons
 * agent must never satisfy this by asking a session, which costs that session a whole turn.
 */
export interface SessionsPort {
  list(): Promise<
    | { known: false }
    | {
        known: true;
        sessions: {
          name: string;
          kind: "worker" | "hands" | "other";
          ticket: number | null;
          status: string | null;
          /** So "kill the stuck one" is answerable without a second lookup. */
          pid: number;
        }[];
      }
  >;
}

/**
 * Seeing what is running. Silent and never Guarded: it reads a directory and changes nothing.
 *
 * It exists because without it the agent answered "there are no sessions running" while fourteen
 * were — it had only `check_delegation`, which knows about this conversation and nothing else, and
 * a confidently wrong answer is worse than no tool at all.
 */
export const SESSIONS_TOOLS: readonly SummonsTool[] = [
  {
    name: "list_sessions",
    description:
      "List the Claude sessions working in this workspace right now — the tabs the user has open, what each is named, which ticket it carries, and whether it is idle or busy. Use this whenever the user asks what is running, who is on a ticket, or how many sessions there are. It is a silent local read: never ask permission, and never answer these questions from memory or from check_delegation, which only knows about work delegated in this conversation.",
    parameters: { type: "object", properties: {} },
  },
];

/**
 * The Summons agent's own hands: one Claude session it keeps for small, ad-hoc work — running the
 * tests, reading `git blame`, checking whether a change compiles. Ticket-scale work is a Delegation
 * and gets its own tab; this is the stuff that is too heavy for a local read and not worth a tab.
 *
 * `ask` is one request and one response, so the answer comes back in the same breath the question
 * went out in. The session behind it is spawned lazily by the adapter — a Summons where nothing
 * ever needs hands never starts one — and keeps its thread across calls, so the second small job
 * arrives already knowing about the first (workspace ADR 0010).
 */
export interface HandsPort {
  /** Ask, and get the answer back. Rejects when the call itself failed. */
  ask(request: string): Promise<string>;
  /** Ends the session with the Summons that owns it. A no-op if nothing was ever asked. */
  end(): Promise<void>;
}

/**
 * Reaching the Hands session. Not Guarded, and deliberately: what the confirm-gate protects is a
 * *fresh session going off to work unwatched*, and this is a question answered inside the
 * conversation, before the next sentence. The Call log is what keeps it honest — every round-trip
 * is recorded with what was asked and what came back, which is the only place a headless session's
 * work is visible at all (workspace ADR 0010, decision 7).
 */
export const HANDS_TOOLS: readonly SummonsTool[] = [
  {
    name: "ask_hands",
    description:
      "Ask your hands — a Claude session kept for this conversation — to do one small job and tell you the answer: run the tests, check whether that compiles, what git blame says here, what a session concluded. Use it whenever you need the result before you can say your next sentence; it answers into the conversation, in one round trip, and remembers the earlier things you asked it. The line against research is not read-only versus not — both mostly read — it is that this answers now and a research session goes away and works where the user can watch it. So a question about how the codebase works is research; a fact you need to finish the sentence you are saying is this. Work that would leave a file changed is delegate.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "What to do, written out for someone who cannot hear this conversation. Say what would count as an answer, since what comes back is what you read out.",
        },
      },
      required: ["request"],
    },
  },
];

/**
 * The hub ticket, as steering needs it: who is carrying it, and somewhere to record a change.
 *
 * `claim` degrades to unknown rather than to "nobody holds it", and steering fails closed on
 * unknown. That distinction is the whole guarantee — a scope that reads an unreachable hub as an
 * unclaimed ticket would let a spoken instruction into work nobody meant (ADR 0010 decision 9).
 */
export interface TicketsPort {
  claim(ticket: number): Promise<{ known: false } | { known: true; session: string | null }>;
  /** Only ever called for an instruction that changes what *done* means — see `STEER_TOOLS`. */
  comment(ticket: number, body: string): Promise<void>;
}

/**
 * Filing a hub ticket — the only write a Summons performs anywhere, and it goes to the hub rather
 * than into the working tree (ADR 0009). Kept as its own narrow port precisely so that claim is
 * checkable: this is the one seam through which a Summons can create anything.
 */
export interface TicketFilingPort {
  file(request: { title: string; body: string }): Promise<{ number: number; url: string }>;
}

/**
 * Turning the conversation into a ticket. Guarded, and through the same gate as everything else
 * Guarded — the agent proposes a title and a body, and the user's yes is what files it.
 */
export const TICKET_TOOLS: readonly SummonsTool[] = [
  {
    name: "file_ticket",
    description:
      "Turn what you have been discussing into a ticket in this workspace's hub — 'summarize that into a ticket', 'open an issue for that'. Calling this files NOTHING: it asks the user to confirm out loud first. Say out loud the title you are about to file and ask for a plain yes or no, then stop — their answer is what decides. This is the only thing you can write anywhere, so get the title and body right before you propose them.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "One line naming the piece of work, as a person scanning a backlog would need to read it.",
        },
        body: {
          type: "string",
          description:
            "The ticket, written out for someone who was not in this conversation: what needs doing, why it came up, and what would count as done. Full sentences — nothing here is inferable from the conversation, because they cannot hear it.",
        },
      },
      required: ["title", "body"],
    },
  },
];

/**
 * Redirecting work that is already running. Neither tool addresses a session itself: the Summons
 * agent is not a Claude session, so both go out through the Hands session, which is (ADR 0010
 * decision 6). Which session may be addressed is decided here and not there — see `resolveTarget`.
 *
 * `steer_session` is not Guarded, deliberately. Sessions run in auto mode and their own permission
 * prompts are the real gate; a message is speech to another agent, not an action on the workspace,
 * and confirming every steer would make the feature unusable in the workflow it exists for.
 * `stop_session` is Guarded, because it destroys work already done and nothing downstream catches
 * it (decision 8).
 */
export const STEER_TOOLS: readonly SummonsTool[] = [
  {
    name: "steer_session",
    description:
      "Redirect a Claude session that is ALREADY RUNNING — 'rebase onto main first', 'drop that approach', 'also check the tests'. Use this the moment the user wants to change what a running session is doing; it is the whole point of talking while work is in flight. It launches nothing and needs no confirmation. The instruction is relayed to that session, which takes it up at its next safe point rather than immediately, so report it as passed on, never as done. To stop or abandon a session, use stop_session instead — not this.",
    parameters: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description:
            "Which session to steer, by the name list_sessions reports, or its ticket number. Omit only when there is just one session running; with several, you will be asked which.",
        },
        instruction: {
          type: "string",
          description:
            "What to tell it, written out for someone who cannot hear this conversation. The user's own words and specifics, in full sentences — it is relayed verbatim.",
        },
        changes_acceptance_criteria: {
          type: "boolean",
          description:
            "True only when this changes what *done* means for the ticket — a new requirement, a dropped one, a different definition of finished. That gets written to the ticket, because it outlives the session. A plain course correction does not: leave this out.",
        },
      },
      required: ["instruction"],
    },
  },
  {
    name: "stop_session",
    description:
      "Tell a running session to stop or abandon what it is doing. Calling this stops NOTHING: it asks the user to confirm out loud first, because stopping destroys work already done and nothing else will catch it. Say out loud what you are about to stop, ask for a plain yes or no, and stop — their answer is what decides.",
    parameters: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description:
            "Which session to stop, by the name list_sessions reports, or its ticket number.",
        },
        reason: {
          type: "string",
          description: "Why it is being stopped, so the session can wind up knowing what happened.",
        },
      },
    },
  },
];

/** What the user asked for, once the agent has written it down as an instruction. */
export interface DelegationRequest {
  task: string;
  label: string;
  /**
   * True for a question rather than a job. Carries a guarantee, not a hint: the session it spawns
   * runs in a permission mode that cannot write, which is the whole reason it needs no confirmation.
   */
  readOnly: boolean;
  ticket?: number | undefined;
  repo?: string | undefined;
  /**
   * The conversation the request came out of, so the session starts informed rather than from one
   * decontextualised sentence. Kept inline rather than pointed at the Call log: the session must
   * arrive knowing what was said, not needing to go and read it.
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
  /**
   * A slice of the reply, to play. `itemId` names the assistant message it belongs to, which is
   * what an interruption needs: the server has to be told how much of *that message* was heard.
   */
  | { type: "audio"; pcm: string; itemId?: string | undefined }
  /** The server's voice-activity detection heard the user start talking. */
  | { type: "user_speaking"; itemId?: string | undefined }
  /**
   * What the user actually said, once the server finished transcribing it. `itemId` identifies the
   * utterance, which matters for the confirm-gate: transcription lags, so an utterance can be
   * transcribed *after* the reply it provoked, and the gate must not read it as an answer.
   */
  | { type: "user_transcript"; text: string; itemId?: string | undefined }
  /**
   * The server has begun a reply. The bracket around `reply_done`, and needed for the same reason:
   * a cancel is only legal while a response is in flight, and until this existed the only proof of
   * one was its audio — so a reply interrupted before it reached the speakers was not cancelled at
   * all, and a typed turn sent in that window collided with it.
   */
  | { type: "reply_started" }
  /**
   * The model has finished generating a reply — there may still be minutes of it queued to play.
   * Worth knowing only so an interruption does not ask to cancel a reply that is already over,
   * which the API answers with an error the user would then hear about for nothing.
   */
  | { type: "reply_done" }
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
  /** Stop generating the reply that is in flight — the user has started talking over it. */
  cancelResponse(): void;
  /**
   * Say how much of an assistant message actually reached the room. The server produces audio
   * faster than it plays, so without this the model believes it said everything it generated and
   * refers back to sentences nobody heard.
   */
  truncateAudio(itemId: string, playedMs: number): void;
  /**
   * A typed utterance, as an ordinary user turn — and a reply asked for, which is the whole
   * difference from `sendAgentNote`. Nothing was heard, so no voice-activity detection has started
   * a reply for this to steer; without asking, a typed line sits in the conversation unanswered.
   */
  sendUserText(text: string): void;
  /**
   * Put a note from the controller into the conversation, for things the agent must say that no
   * tool call is waiting on — above all the verdict of the confirm-gate, which the controller
   * decides after the tool call has already been answered.
   */
  sendAgentNote(text: string): void;
  /**
   * A note *and* an ask: something happened that the agent should tell the user about, with nobody
   * having spoken to prompt it. The one thing a Summons says unbidden — a delegated session
   * finishing — and the reason it is not `sendAgentNote` is precisely that nothing is under way for
   * a note to steer.
   */
  promptAgent(text: string): void;
  close(): Promise<void>;
}

/**
 * Microphone and speaker. Capture is an open mic — the controller never gates it on a keypress, so
 * the keyboard stays free; the model's own voice-activity detection decides when a turn ends.
 */
export interface AudioPort {
  startCapture(onChunk: (pcm: string) => void): Promise<void>;
  play(pcm: string): void;
  /**
   * Drop everything queued but not yet played. What makes a barge-in feel like an interruption
   * rather than a pause: without it the reply the user talked over keeps coming out of the speakers
   * for however long was already buffered.
   */
  flush(): void;
  /**
   * No more audio is coming for this reply. Distinct from `flush`, which throws away what is left:
   * this says the opposite — play all of it, including the last syllable, which a speaker that
   * cannot tell where a reply ends will otherwise hold back waiting for more.
   */
  endReply(): void;
  stop(): Promise<void>;
}

/** The clock the session runs on; injectable so tests drive time instead of waiting on it. */
export interface TimerPort {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: TimerPort = {
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
export const PLAYBACK_TAIL_MS = 400;
const PCM16_BYTES_PER_MS = (24_000 * 2) / 1000;

/** How long a base64 PCM16 chunk takes to play, in milliseconds. */
function playbackDurationMs(base64Pcm: string): number {
  const padding = base64Pcm.endsWith("==") ? 2 : base64Pcm.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, (base64Pcm.length / 4) * 3 - padding);
  return bytes / PCM16_BYTES_PER_MS;
}

/**
 * How much louder than the settled echo a frame must be to be a person rather than the agent. A
 * ratio and not a fixed level, because it has to hold at any speaker volume.
 */
const BARGE_IN_RATIO = 2;
/**
 * ...and this loud outright. With the volume very low the echo floor sits near zero, and twice
 * almost-nothing is still almost-nothing — without a floor of its own a chair scraping would cut
 * the agent off.
 */
const BARGE_IN_MIN_LEVEL = 1_200;
/** Consecutive frames it takes: one is a door closing, two is somebody talking. */
const BARGE_IN_FRAMES = 2;
/** How fast the echo floor follows the room. Slow, so a voice cannot drag the floor up after it. */
const ECHO_FLOOR_WEIGHT = 0.3;
/** Frames spent learning how loud the room is before an interruption can be heard at all. */
const ECHO_WARMUP_FRAMES = 1;
/**
 * The least time between two interruptions the level detector may cause. The detector is a
 * heuristic, so what this bounds is the cost of it being wrong: a mistake should sound like one
 * clipped word, never like a reply being shredded frame by frame.
 */
const BARGE_IN_COOLDOWN_MS = 1_500;
/** 20ms — short enough that a syllable starting late in a frame still stands out in it. */
const LEVEL_WINDOW_SAMPLES = 24_000 / 50;

/**
 * The loudest 20ms of a mic frame, as RMS. Peak rather than average over the whole frame: a frame
 * is ~200ms, and a word that starts two thirds of the way through one would average away to
 * nothing.
 */
function peakLevel(base64Pcm: string): number {
  const bytes = Buffer.from(base64Pcm, "base64");
  const samples = Math.floor(bytes.length / 2);
  let peak = 0;
  for (let start = 0; start < samples; start += LEVEL_WINDOW_SAMPLES) {
    const end = Math.min(start + LEVEL_WINDOW_SAMPLES, samples);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const sample = bytes.readInt16LE(i * 2);
      sum += sample * sample;
    }
    if (end > start) peak = Math.max(peak, Math.sqrt(sum / (end - start)));
  }
  return peak;
}

/** Default silence window before a Summons hangs itself up, so a forgotten mic stops billing. */
export const DEFAULT_SUMMONS_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * What the Summons is doing, as a status line has to say it.
 *
 * One snapshot rather than two feeds, because it is one line: two writers racing for it means the
 * last one wins and drops the other's news. The echo gate owns the mic half and the controller owns
 * the conversation half, and the controller composes them.
 *
 * The level and the floor exist nowhere else — computed frame by frame inside the gate, and once
 * emitted only as debug prose — and they are the two numbers that explain a barge-in that fired or
 * did not. Watching them while talking over a reply is how the thresholds get tuned at all.
 */
export interface SummonsStatus {
  /** The user has the mic shut. Nothing reaches the model until they open it again. */
  muted: boolean;
  /**
   * What is happening, output-side. `listening` means idle — and means only that, which is the whole
   * point: a Summons composing a reply or running a tool used to say the same word as one doing
   * nothing at all, so the one question a status line exists to answer had no answer.
   */
  doing: "listening" | "thinking" | "working" | "speaking";
  /** The tool in flight, when `doing` is `working`. "Waiting" and "checking" are not the same thing. */
  tool?: string | undefined;
  /** How long `thinking` or `working` has run — because the question being asked is "is it stuck?". */
  forMs: number;
  /**
   * Peak level of the last mic frame, admitted or held back. Zero while muted: the number says what
   * the model is hearing, and a muted mic is heard by nobody however loud the room is.
   */
  level: number;
  /**
   * The level the agent's own echo settles at, learned from the frames the gate holds back — null
   * until the room has been characterised, which only happens once a reply has played.
   */
  floor: number | null;
  /**
   * Work handed to Claude sessions in this conversation, as it stands. Empty for the great majority
   * of Summonses, and the answer to "am I still connected to what I asked for" for the rest.
   */
  delegations: readonly SummonsDelegationStatus[];
}

/** The mic half of a `SummonsStatus`, as the echo gate knows it. */
interface GateReport {
  muted: boolean;
  speaking: boolean;
  /** A reply is being generated — true from `response.created` until it is done or cancelled. */
  generating: boolean;
  /** When the generation in flight began, so a long silence is visibly a long one. */
  generatingSince: number | null;
  level: number;
  floor: number | null;
}

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
  /** Omitted, the agent has no hands: it can talk, read and delegate, and nothing else. */
  hands?: HandsPort | undefined;
  /** Omitted, the agent cannot see what else is running in the workspace. */
  sessions?: SessionsPort | undefined;
  /** Omitted, the agent cannot steer: it has no way to check who is claimed to what. */
  tickets?: TicketsPort | undefined;
  /** Omitted, the agent cannot file a ticket, and so writes nothing anywhere at all. */
  filing?: TicketFilingPort | undefined;
  audio?: AudioPort | undefined;
  /**
   * The user has declared they are on headphones, so nothing the agent says reaches the mic. The
   * echo gate comes off and the mic stays open through the reply, which is what lets the model's
   * own voice detection hear an interruption the instant it starts. On speakers this cannot be the
   * default: an open mic there hears the agent and the conversation dies chewing on its own echo.
   */
  headphones?: boolean | undefined;
  /**
   * Whether the user may cut a reply off by talking over it. On by default.
   *
   * Turning it off is how you find out whether a reply that stops early was interrupted or died:
   * with no interruption possible, a reply that still stops short stopped for some other reason.
   * It also stands on its own for a room the echo detector reads badly — a reply that plays to its
   * end every time is worth more than being able to talk over it.
   */
  bargeIn?: boolean | undefined;
  instructions: string;
  model?: string | undefined;
  voice?: string | undefined;
  /** Silence window before the session hangs up. 0 (or negative) keeps it open indefinitely. */
  idleTimeoutMs?: number | undefined;
  timers?: TimerPort | undefined;
  /**
   * Where the Summons writes its Call log. Omitted, the conversation happens unrecorded — which is
   * fine for a test and not fine for a Summons with a headless Hands session behind it (ADR 0010).
   */
  callLog?: CallLogPort | undefined;
  /** Fires once when the session ends — including when it hangs itself up on silence. */
  onStopped?: (() => void) | undefined;
  /** Called with anything the API reports going wrong, so the user isn't left talking to silence. */
  onError?: ((message: string) => void) | undefined;
  /**
   * Where the Summons reports what it is doing, so a status line needs no debug prose to parse.
   * Called on every mic frame and on every change worth showing, so it is a status *feed*: the
   * receiver decides how often to redraw.
   */
  onStatus?: ((status: SummonsStatus) => void) | undefined;
  /**
   * Traces the decisions no other output can explain — above all what the echo detector heard and
   * what it made of it. Those thresholds are a heuristic against a real room, so tuning them needs
   * the numbers, and the numbers only exist during a live conversation.
   */
  onDebug?: ((message: string) => void) | undefined;
}

export interface SummonsSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Suspend or resume mic input, returning the state it is now in. For a side conversation in the
   * room that must not be read as instructions — the socket stays open, so the idle window keeps
   * running and a session muted and forgotten still hangs itself up.
   */
  toggleMute(): boolean;
  /**
   * A typed utterance: the same turn a spoken one is, and treated as one throughout — answered in
   * voice, and able to answer the confirm-gate. The channel is recorded so a person reading the
   * conversation back can tell them apart, not so the agent can.
   *
   * Blank input is not a turn, and the mic is left exactly as the user set it — muting is theirs
   * alone, so typing neither opens nor closes it.
   */
  typed(text: string): Promise<void>;
  /**
   * Cut the reply off from the keyboard — `Esc`. The third barge-in source, and the only one that
   * is not a guess about whether a person is talking, so it is obeyed even with barge-in switched
   * off.
   *
   * Answers whether there was a reply to cut off, since `Esc` on a quiet Summons means something
   * else entirely — clearing the input line — and the view cannot tell the two apart on its own.
   */
  interrupt(): boolean;
  /**
   * Record something only the outside knows — an audio subsystem dying, say. Without this the Call
   * log of a session killed by a dead speaker read as an ordinary hang-up, and the one line that
   * explained it existed nowhere but the terminal it scrolled past in.
   */
  note(text: string, level?: "info" | "error"): void;
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

/**
 * What a delegation tool did with the call, reported back so the controller can record the tool
 * call itself — `research` and `delegate` answer their own calls, so it cannot see the result.
 */
type ToolOutcome = { outcome: "ok" | "error" | "held"; detail?: string | undefined };

interface TrackedDelegation {
  /** The label lives on the request alone, so it cannot drift from what was delegated. */
  request: DelegationRequest;
  /** null while the delegation is queued behind another on the same repo. */
  handle: DelegationHandle | null;
  /** Set once the session has been observed to have finished, which frees its repo. */
  finished: boolean;
  queuedBehind: string | null;
  /** When its session started, so a Summons can show how long the work has been running. */
  launchedAt: number | null;
  /** The last status anyone read off it, so the footer has something to show between polls. */
  lastSeen: DelegationStatus | null;
}

/** How often the Summons looks at what it delegated. About not being noisy: the read is ~20ms. */
const DELEGATION_POLL_MS = 10_000;

/** One delegation, as a status line shows it. */
export interface SummonsDelegationStatus {
  label: string;
  /** null while queued behind another task on the same repo. */
  session: string | null;
  state: "queued" | "running" | "finished" | "unknown";
  /** How long since its session started. Zero while queued. */
  forMs: number;
}

/** A delegated session having stopped — the one thing a Summons says without being asked. */
export interface FinishedDelegation {
  label: string;
  session: string;
  /** The last thing the session said, which is the answer the user is waiting for. */
  latest: string | null;
  /** A queued task this one finishing let start, if there was one. */
  alsoStarted: string | null;
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
 * An action held back until the user says yes out loud. There is one gate for the whole
 * conversation and every Guarded action goes through it — a second gate would be a second place
 * for the rule to drift, and two proposals waiting at once is a spoken "yes" with no clear referent.
 */
interface GatedAction {
  /** What the user is being asked about, as the Call log names it. */
  label: string;
  /**
   * The utterance that *caused* the proposal. Transcription lags, so the request can be transcribed
   * after the reply it provoked, and the gate must not read it as the answer to itself.
   */
  askedAfterItemId: string | null;
  /** What did not happen, said back when the answer is anything but a clear yes. */
  nothingHappened: string;
  /** Runs on a yes, and returns the note the agent is given. */
  run(): Promise<string>;
  /** How a failure of `run` is put to the user. */
  failed(message: string): string;
}

/**
 * The confirm-gate. It lives here, and not in the agent's instructions, for the reason the whole
 * design turns on: a model that decides its own confirmations has not been gated at all.
 */
function createGate(opts: SummonsSessionOptions) {
  const log = opts.callLog ?? NULL_CALL_LOG;
  let pending: GatedAction | null = null;

  return {
    /**
     * Why this call must not proceed, when something is already waiting on an answer.
     *
     * Every tool that could put a second question in the air asks this first — not just the ones
     * that hold the gate themselves. A steer accepted while a stop waits makes the agent speak
     * again, and the user's "yes" to *that* releases the stop instead: a session destroyed on a
     * confirmation nobody gave.
     */
    blocked(): string | null {
      return pending
        ? `"${pending.label}" is already waiting on a yes or no. Get an answer to that first.`
        : null;
    },

    /** Put an action aside. Does no I/O at all — nothing can be launched from here. */
    hold(action: GatedAction): void {
      pending = action;
    },

    /**
     * The user has answered while something is held — spoken or typed, which is the same thing.
     * Only an unambiguous yes releases it: a no and anything unclear both decline, because a
     * misheard sentence must never act. Returns false when the utterance was not an answer at all,
     * leaving the gate held.
     */
    async resolve(text: string, itemId: string | null): Promise<boolean> {
      const action = pending;
      if (!action) return false;
      if (itemId && itemId === action.askedAfterItemId) return false;
      pending = null;

      const verdict = classifyConfirmation(text);
      // Recorded before anything acts on it: the gate's verdict, and the words it was read from,
      // are the one thing a later reader most needs to check the agent against.
      log.record({
        type: "gate",
        label: action.label,
        verdict:
          verdict === "negative" ? "declined" : verdict === "unclear" ? "unclear" : "confirmed",
        heard: text,
      });
      if (verdict === "negative") {
        opts.transport.sendAgentNote(
          `The user declined "${action.label}". ${action.nothingHappened} Acknowledge briefly and move on.`,
        );
        return true;
      }
      if (verdict === "unclear") {
        opts.transport.sendAgentNote(
          `That was not a clear yes, so "${action.label}" did NOT go ahead. ${action.nothingHappened} Ask again for a plain yes or no.`,
        );
        return true;
      }
      try {
        opts.transport.sendAgentNote(await action.run());
      } catch (err) {
        opts.transport.sendAgentNote(
          action.failed(err instanceof Error ? err.message : String(err)),
        );
      }
      return true;
    },
  };
}

type Gate = ReturnType<typeof createGate>;

/**
 * Delegation: holding a proposed job at the gate until the user says yes, tracking what has been
 * handed out, and keeping two tasks on one repo from running at once.
 */
function createDelegations(
  opts: SummonsSessionOptions,
  gate: Gate,
  timers: TimerPort,
  /**
   * Anything that changed what the roster says. `finished` is set only for the one change worth
   * saying out loud; every other one — a launch, a queue, a poll that saw a session go unreadable —
   * is a redraw and nothing more.
   */
  onChange: (finished: FinishedDelegation | null) => void,
) {
  const actions = opts.actions;
  const log = opts.callLog ?? NULL_CALL_LOG;
  const tracked: TrackedDelegation[] = [];
  const conversation: string[] = [];

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
    entry.launchedAt = timers.now();
    entry.lastSeen = "running";
    watch();
    onChange(null);
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

  function readRequest(rawArgs: string, tool: string, readOnly: boolean): DelegationRequest {
    const args = parseArgs(rawArgs, tool);
    return {
      task: requireString(args, "task", tool),
      label: uniqueLabel(requireString(args, "label", tool)),
      readOnly,
      ticket: optionalPositiveInteger(args, "ticket"),
      repo: optionalString(args, "repo"),
      conversation: conversation.length > 0 ? conversation.join("\n") : undefined,
    };
  }

  type DispatchOutcome =
    | { launched: true; label: string; session: string }
    | { launched: false; label: string; queuedBehind: string };

  /**
   * What the Call log says about a delegation. It is the record of the `research`/`delegate` tool
   * call *and* of the work — which session was spawned is the part that matters later, since the
   * name is the address the session is reachable at.
   */
  function recordDelegation(
    request: DelegationRequest,
    result:
      | { status: "launched"; session: string | null }
      | { status: "finished"; session: string; detail?: string | undefined }
      | { status: "queued"; detail: string }
      | { status: "failed"; detail: string },
  ): void {
    const named = result.status === "launched" || result.status === "finished";
    log.record({
      type: "delegation",
      mode: request.readOnly ? "research" : "delegate",
      label: request.label,
      task: request.task,
      session: named ? result.session : null,
      status: result.status,
      ...(named ? {} : { detail: result.detail }),
      ...(result.status === "finished" && result.detail ? { detail: result.detail } : {}),
      ...(request.ticket ? { ticket: request.ticket } : {}),
      ...(request.repo ? { repo: request.repo } : {}),
    });
  }

  /** Everything launched and not yet known to have stopped — what there is to watch. */
  function running(): TrackedDelegation[] {
    return tracked.filter((t) => t.handle && !t.finished);
  }

  let watchHandle: unknown = null;

  /**
   * Look at what was delegated, on a clock, so a session stopping is something the Summons *notices*
   * rather than something only a later question would have uncovered. It was the one thing a Summons
   * did whose outcome it never mentioned.
   *
   * Scheduled only while something is running, and cleared when the Summons hangs up — a poll timer
   * outliving the conversation is a process that will not exit.
   */
  function watch(): void {
    if (watchHandle !== null || !actions || running().length === 0) return;
    watchHandle = timers.setTimeout(() => {
      watchHandle = null;
      void poll();
    }, DELEGATION_POLL_MS);
  }

  async function poll(): Promise<void> {
    let changed = false;
    for (const entry of running()) {
      if (!entry.handle || !actions) continue;
      let report: DelegationReport;
      try {
        report = await actions.observe(entry.handle);
      } catch {
        // An unreadable registry is not a finished session (`statusOf` is careful about this for the
        // same reason) — so this looks again next time rather than announcing anything.
        continue;
      }
      entry.lastSeen = report.status;
      if (report.status !== "finished") continue;
      changed = true;
      entry.finished = true;
      const alsoStarted = await drain(entry.request.repo);
      recordDelegation(entry.request, {
        status: "finished",
        session: entry.handle.sessionName,
        ...(alsoStarted ? { detail: `freed the repo, so "${alsoStarted}" started` } : {}),
      });
      onChange({
        label: labelOf(entry),
        session: entry.handle.sessionName,
        latest: report.latest,
        alsoStarted,
      });
    }
    // A poll that saw nothing finish can still have changed what the roster says — a session going
    // unreadable, or an age ticking over — so the redraw is unconditional and the announcement is not.
    if (!changed) onChange(null);
    watch();
  }

  /** Track and launch. Throws only if the launch itself failed, leaving nothing tracked. */
  async function dispatch(request: DelegationRequest): Promise<DispatchOutcome> {
    const entry: TrackedDelegation = {
      request,
      handle: null,
      finished: false,
      queuedBehind: null,
      launchedAt: null,
      lastSeen: null,
    };
    tracked.push(entry);
    try {
      const outcome = await launchOrQueue(entry);
      if (outcome.started) {
        const session = entry.handle?.sessionName ?? "";
        // `session: null` in the record means "no session to point at", so a nameless launch must
        // record null rather than an empty string a reader would see as a blank address.
        recordDelegation(request, { status: "launched", session: session || null });
        return { launched: true, label: request.label, session };
      }
      recordDelegation(request, { status: "queued", detail: outcome.behind });
      onChange(null);
      return { launched: false, label: request.label, queuedBehind: outcome.behind };
    } catch (err) {
      tracked.pop();
      recordDelegation(request, {
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return {
    remember,

    /**
     * Launch a read-only question straight away. Not an exception to the gate — the gate is on
     * *change*, and this cannot change anything (see `DELEGATION_TOOLS`). Making the user confirm
     * every question was the cost that made them stop asking questions.
     */
    async research(callId: string, rawArgs: string): Promise<ToolOutcome> {
      const answer = (payload: Record<string, unknown>) =>
        opts.transport.sendToolResult(callId, JSON.stringify(payload));
      if (!actions) {
        const error = "This Summons cannot delegate — it was started without workspace actions.";
        answer({ error });
        return { outcome: "error", detail: error };
      }
      try {
        const outcome = await dispatch(readRequest(rawArgs, "research", true));
        answer(
          outcome.launched
            ? { launched: true, label: outcome.label, session: outcome.session }
            : { launched: false, label: outcome.label, queued_behind: outcome.queuedBehind },
        );
        return { outcome: "ok" };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        answer({ error: detail });
        return { outcome: "error", detail };
      }
    },

    /**
     * Hold a proposed delegation at the gate. Nothing is launched here, and nothing can be — this
     * does no I/O at all; the request is put aside and the agent is told to go and ask.
     */
    propose(callId: string, rawArgs: string, lastUserItemId: string | null): ToolOutcome {
      const answer = (payload: Record<string, unknown>) =>
        opts.transport.sendToolResult(callId, JSON.stringify(payload));
      if (!actions) {
        const error = "This Summons cannot delegate — it was started without workspace actions.";
        answer({ error });
        return { outcome: "error", detail: error };
      }
      const blocked = gate.blocked();
      if (blocked) {
        answer({ error: blocked });
        return { outcome: "error", detail: blocked };
      }
      let request: DelegationRequest;
      try {
        request = readRequest(rawArgs, "delegate", false);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        answer({ error: detail });
        return { outcome: "error", detail };
      }
      const label = request.label;
      gate.hold({
        label,
        askedAfterItemId: lastUserItemId,
        nothingHappened: "Nothing was launched.",
        async run() {
          const outcome = await dispatch(request);
          return outcome.launched
            ? `Launched "${label}" in a Claude session (${outcome.session}). Tell the user it is running and that they can ask how it is going.`
            : `"${label}" is queued behind "${outcome.queuedBehind}" — they touch the same repo, so they cannot run at once. Tell the user it will start when that one finishes.`;
        },
        failed: (message) =>
          `Launching "${label}" failed: ${message}. Nothing is running. Tell the user plainly.`,
      });
      answer({
        status: "awaiting_confirmation",
        launched: false,
        label,
        instruction:
          "Nothing has been launched. Say out loud, in one sentence, what you are about to hand to Claude, then ask the user to answer yes or no. Do not call delegate again — their answer is what decides.",
      });
      return { outcome: "held", detail: label };
    },

    /** What is delegated and how it stands, for the status line. Never asks anyone: reads what the watch loop last saw. */
    roster(): SummonsDelegationStatus[] {
      return tracked.map((entry) => ({
        label: labelOf(entry),
        session: entry.handle?.sessionName ?? null,
        state: entry.finished
          ? ("finished" as const)
          : !entry.handle
            ? ("queued" as const)
            : entry.lastSeen === "unknown"
              ? ("unknown" as const)
              : ("running" as const),
        forMs: entry.launchedAt === null ? 0 : Math.max(0, timers.now() - entry.launchedAt),
      }));
    },

    /** Hanging up stops the watch: a poll timer outliving its Summons is a process that never exits. */
    stopWatching(): void {
      timers.clearTimeout(watchHandle);
      watchHandle = null;
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

/**
 * Filing: the second Guarded action, held at the same gate as the first. Nothing here does any I/O
 * until the user has said yes — the tool call only ever writes the proposal down.
 */
function createFiling(opts: SummonsSessionOptions, gate: Gate) {
  const log = opts.callLog ?? NULL_CALL_LOG;

  return {
    propose(callId: string, rawArgs: string, lastUserItemId: string | null): ToolOutcome {
      const answer = (payload: Record<string, unknown>) =>
        opts.transport.sendToolResult(callId, JSON.stringify(payload));
      const filing = opts.filing;
      if (!filing) {
        const error = "This Summons cannot file tickets — it was started without a hub to file to.";
        answer({ error });
        return { outcome: "error", detail: error };
      }
      const blocked = gate.blocked();
      if (blocked) {
        answer({ error: blocked });
        return { outcome: "error", detail: blocked };
      }
      let title: string;
      let body: string;
      try {
        const args = parseArgs(rawArgs, "file_ticket");
        title = requireString(args, "title", "file_ticket");
        body = requireString(args, "body", "file_ticket");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        answer({ error: detail });
        return { outcome: "error", detail };
      }
      gate.hold({
        label: `file "${title}"`,
        askedAfterItemId: lastUserItemId,
        nothingHappened: "Nothing was filed.",
        async run() {
          const issue = await filing.file({ title, body });
          // The one write a Summons makes, so it goes in the record with somewhere to go and read
          // it — the gate entry above already says what was heard to authorise it.
          log.record({
            type: "note",
            level: "info",
            text: `Filed #${issue.number} in the hub — ${title} (${issue.url})`,
          });
          return `Filed it as #${issue.number}: "${title}" (${issue.url}). Tell the user the number.`;
        },
        failed: (message) =>
          `Filing "${title}" failed: ${message}. Nothing was filed. Tell the user plainly.`,
      });
      answer({
        status: "awaiting_confirmation",
        filed: false,
        title,
        instruction:
          "Nothing has been filed. Say the title out loud, in one sentence, then ask the user to answer yes or no. Do not call file_ticket again — their answer is what decides.",
      });
      return { outcome: "held", detail: title };
    },
  };
}

/**
 * Stamped on the ticket notes steering writes, so servant can find its own among the discussion —
 * the same discipline as `CLAIM_MARKER`.
 */
export const STEER_TICKET_MARKER = "<!-- servant:steer -->";

/** A session this Summons may address, once the registry and the hub have both allowed it. */
interface SteerTarget {
  name: string;
  /** The ticket a Worker session carries; null for the conversation's own hands. */
  ticket: number | null;
}

/**
 * Steering: deciding which running session may be addressed, and relaying an instruction to it.
 *
 * The Claim check lives here rather than in the Hands session's prompt, which is a deliberate
 * amendment to ADR 0010's reasoning. Routing delivery through the hands is what the ADR decided
 * and what happens; but *which* session may be addressed is enforced deterministically, because a
 * model that decides its own scoping has not been scoped — the same reason the confirm-gate is not
 * left to the agent's instructions. The Hands prompt still carries the rule, as a backstop that is
 * not load-bearing.
 */
function createSteering(opts: SummonsSessionOptions, gate: Gate, timers: TimerPort) {
  const log = opts.callLog ?? NULL_CALL_LOG;

  /** Everything the registry says is running here, workspace-scoped by construction (AC 5). */
  async function candidates(): Promise<
    { known: false } | { known: true; targets: SteerTarget[]; unaddressable: string[] }
  > {
    const report = await opts.sessions?.list();
    if (!report || !report.known) return { known: false };
    const targets: SteerTarget[] = [];
    const unaddressable: string[] = [];
    for (const session of report.sessions) {
      if (session.kind === "worker" && session.ticket !== null) {
        targets.push({ name: session.name, ticket: session.ticket });
      } else if (session.kind === "hands") {
        targets.push({ name: session.name, ticket: null });
      } else {
        // A session the user started by hand carries no ticket and so holds no Claim. Nameable,
        // deliberately not addressable — the agent has to be able to say why (AC 4).
        unaddressable.push(session.name);
      }
    }
    return { known: true, targets, unaddressable };
  }

  /** How a person names a session out loud: its name, or the ticket it carries. */
  function matches(target: SteerTarget, wanted: string): boolean {
    const want = wanted.trim().toLowerCase().replace(/^#/, "");
    if (target.name.toLowerCase() === want) return true;
    if (
      target.ticket !== null &&
      (want === String(target.ticket) || want === `t${target.ticket}`)
    ) {
      return true;
    }
    return false;
  }

  type Resolved =
    | { ok: true; target: SteerTarget }
    | { ok: false; refusal: Record<string, unknown>; detail: string };

  const refuse = (error: string): Resolved => ({ ok: false, refusal: { error }, detail: error });

  /**
   * Which session an instruction is for. Fails closed at every step: an unreadable registry, an
   * unreachable hub and a ticket claimed by somebody else all refuse rather than guess, because
   * the one thing steering must never do is put a spoken instruction into unrelated work.
   */
  async function resolveTarget(wanted: string | undefined): Promise<Resolved> {
    const found = await candidates();
    if (!found.known) {
      return refuse(
        "This machine's session registry could not be read, so you cannot tell which session that is. Say so — do not guess at a name.",
      );
    }
    if (!wanted) {
      // The hands are reachable but never the default: "tell it to rebase" means the work, not the
      // conversation's own errand-runner.
      const workers = found.targets.filter((t) => t.ticket !== null);
      if (workers.length === 0) {
        return refuse(
          found.unaddressable.length > 0
            ? `Nothing addressable is running. ${found.unaddressable.join(", ")} ${found.unaddressable.length === 1 ? "is" : "are"} running but ${found.unaddressable.length === 1 ? "carries" : "carry"} no ticket, so ${found.unaddressable.length === 1 ? "it holds" : "they hold"} no Claim and cannot be steered.`
            : "No session is running that this workspace can steer.",
        );
      }
      // AC 11: picking one would send the user's instruction into work they did not mean.
      //
      // Counted over sessions carrying a ticket, not over sessions whose Claim has been read —
      // reading every Claim here would be one `gh` round trip per session while the user is
      // mid-sentence. The cost is asking "which one?" in the rare case where several are running
      // and only one is actually claimed; the Claim is still checked on whichever they name, so
      // the scope never widens, only the question gets asked once more than it had to.
      if (workers.length > 1) {
        return {
          ok: false,
          refusal: {
            needs_disambiguation: true,
            sessions: workers.map((t) => ({ session: t.name, ticket: t.ticket })),
            instruction:
              "Several sessions are running. Ask the user which one they mean, and say what each is carrying. Do not guess, and do not send it to all of them.",
          },
          detail: "asked which session",
        };
      }
      return { ok: true, target: workers[0] as SteerTarget };
    }

    const matched = found.targets.filter((t) => matches(t, wanted));
    if (matched.length !== 1) {
      const named = found.unaddressable.some((name) => name.toLowerCase() === wanted.toLowerCase());
      return refuse(
        named
          ? `"${wanted}" is running here but carries no ticket, so it holds no Claim and cannot be steered. Say that, and offer to ask your hands instead.`
          : `There is no session called "${wanted}" running in this workspace. Call list_sessions and use a name from it — you cannot reach sessions in other workspaces or other projects.`,
      );
    }
    const target = matched[0] as SteerTarget;
    if (target.ticket === null) return { ok: true, target };

    // AC 4, and the reason `claim` degrades to unknown rather than to null: a hub we could not
    // reach must refuse, not wave the instruction through.
    const claim = await opts.tickets?.claim(target.ticket);
    if (!claim || !claim.known) {
      return refuse(
        `The hub could not be reached to check who holds #${target.ticket}, so nothing was sent. Say that plainly rather than assuming it went.`,
      );
    }
    if (claim.session !== target.name) {
      return refuse(
        claim.session
          ? `#${target.ticket} is claimed by ${claim.session}, not ${target.name}, so ${target.name} was not steered.`
          : `Nobody holds the Claim on #${target.ticket}, so ${target.name} cannot be steered. Only sessions carrying a claimed ticket can be.`,
      );
    }
    return { ok: true, target };
  }

  /** One relayed instruction: recorded going out, recorded coming back, whatever happened. */
  async function deliver(
    target: SteerTarget,
    instruction: string,
    stop: boolean,
  ): Promise<{ result: Record<string, unknown>; outcome: ToolOutcome }> {
    const startedAt = timers.now();
    const message = composeSteerMessage({ instruction, stop });
    // Written before the round trip, not after it: a relay can run for a minute or two, and the
    // Call log is the only place a headless session's work is visible while it is happening.
    log.record({ type: "steer-sent", target: target.name, instruction });

    const finish = (
      status: "delivered" | "unconfirmed" | "failed",
      detail: string | undefined,
      result: Record<string, unknown>,
    ) => {
      log.record({
        type: "steer",
        target: target.name,
        instruction,
        status,
        ...(detail ? { detail } : {}),
        ...(stop ? { stop: true } : {}),
        durationMs: timers.now() - startedAt,
      });
      return {
        result,
        outcome: { outcome: status === "delivered" ? "ok" : "error", detail } as ToolOutcome,
      };
    };

    let reply: string;
    try {
      if (!opts.hands) throw new Error("This Summons has no hands to relay through.");
      reply = await opts.hands.ask(composeSteerRequest({ target: target.name, message }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return finish("failed", reason, {
        status: "failed",
        session: target.name,
        reason,
        instruction: `The instruction did NOT reach ${target.name}: ${reason}. Tell the user plainly that nothing was passed on.`,
      });
    }

    const ack = parseSteerAck(reply);
    if (ack.outcome === "delivered") {
      return finish("delivered", undefined, {
        status: "delivered",
        session: target.name,
        instruction: `The instruction is in ${target.name}'s inbox. Say it has been passed on, and that ${target.name} will take it up at its next safe point. Whether it has acted on it yet is something you do not know, so do not claim it has. If the user wants to know whether it took, check back in a minute.`,
      });
    }
    if (ack.outcome === "failed") {
      return finish("failed", ack.reason, {
        status: "failed",
        session: target.name,
        reason: ack.reason,
        instruction: `The instruction did NOT reach ${target.name}: ${ack.reason || "no reason given"}. Tell the user plainly that nothing was passed on.`,
      });
    }
    // The honest middle, and the reason this is parsed at all: the relay answered without
    // confirming it sent anything, so "delivered" would be an assumption (AC 3).
    return finish("unconfirmed", "the relay did not confirm the send", {
      status: "unconfirmed",
      session: target.name,
      instruction: `Your hands did not confirm the send, so you do not know whether the instruction reached ${target.name}. Say exactly that — do not say it was delivered. Offer to try again.`,
    });
  }

  /** The ticket note an instruction earns only by changing what *done* means (AC 9 and 10). */
  async function noteOnTicket(
    target: SteerTarget,
    instruction: string,
    unconfirmed: boolean,
  ): Promise<void> {
    if (target.ticket === null || !opts.tickets) return;
    // The caveat is on the note rather than a reason to withhold it: whoever reads this ticket
    // later needs the changed criterion *and* the fact that the session may never have heard it.
    const caveat = unconfirmed
      ? "\n\nDelivery to that session was **not confirmed** — it may not have heard this."
      : "";
    try {
      await opts.tickets.comment(
        target.ticket,
        `${STEER_TICKET_MARKER}\n**Steered by voice** — relayed to \`${target.name}\`:\n\n> ${instruction.trim().replace(/\n/g, "\n> ")}${caveat}`,
      );
    } catch (err) {
      // A note that failed to write must not turn a delivered instruction into a reported failure
      // — but it cannot vanish either, or the ticket silently misses what changed.
      log.record({
        type: "note",
        level: "error",
        text: `The steer reached ${target.name} but the ticket note on #${target.ticket} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Not Guarded — unless the words say otherwise, in which case it goes to the gate anyway.
   *
   * `relayed` says whether the call got as far as the relay, and so whether it already wrote its
   * own `steer` entries. Everything short of that — a refusal for scope, a gate already holding,
   * an unreadable registry — leaves no record of its own and has to be logged as a tool call.
   */
  async function steer(
    callId: string,
    rawArgs: string,
    lastUserItemId: string | null,
  ): Promise<ToolOutcome & { relayed: boolean }> {
    const answer = (payload: Record<string, unknown>) =>
      opts.transport.sendToolResult(callId, JSON.stringify(payload));
    let instruction: string;
    let args: Record<string, unknown>;
    try {
      args = parseArgs(rawArgs, "steer_session");
      instruction = requireString(args, "instruction", "steer_session");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      answer({ error: detail });
      return { outcome: "error", detail, relayed: false };
    }
    // A stop phrased as a redirect is still a stop. The separate tool is the signpost; this is
    // what makes the gate hold regardless of which one the model reached for (ADR 0010, 8).
    if (looksLikeStopInstruction(instruction)) {
      return { ...(await stop(callId, rawArgs, lastUserItemId, instruction)), relayed: false };
    }
    // Asked even though steering holds nothing itself: a steer accepted while a stop waits makes
    // the agent speak again, and the user's "yes" to *that* would release the stop.
    const blocked = gate.blocked();
    if (blocked) {
      answer({ error: blocked });
      return { outcome: "error", detail: blocked, relayed: false };
    }
    const resolved = await resolveTarget(optionalString(args, "session"));
    if (!resolved.ok) {
      answer(resolved.refusal);
      return { outcome: "error", detail: resolved.detail, relayed: false };
    }
    // Written on `unconfirmed` too, and deliberately. The note is the part that outlives the
    // session; dropping it because the relay went quiet rounds "we do not know" down to "it did not
    // happen", which is the conflation this whole feature exists to avoid. Only an outright
    // failure — where nothing was sent — leaves the ticket alone.
    const { result, outcome } = await deliver(resolved.target, instruction, false);
    if (args.changes_acceptance_criteria === true && result.status !== "failed") {
      await noteOnTicket(resolved.target, instruction, result.status === "unconfirmed");
    }
    answer(result);
    return { ...outcome, relayed: true };
  }

  /**
   * Guarded, and through the same gate everything else Guarded goes through. The target is
   * resolved before the gate rather than after it, so the user is asked about a session that
   * actually exists and can actually be reached.
   */
  async function stop(
    callId: string,
    rawArgs: string,
    lastUserItemId: string | null,
    instructionOverride?: string,
  ): Promise<ToolOutcome> {
    const answer = (payload: Record<string, unknown>) =>
      opts.transport.sendToolResult(callId, JSON.stringify(payload));
    let args: Record<string, unknown>;
    try {
      args = parseArgs(rawArgs, "stop_session");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      answer({ error: detail });
      return { outcome: "error", detail };
    }
    const blocked = gate.blocked();
    if (blocked) {
      answer({ error: blocked });
      return { outcome: "error", detail: blocked };
    }
    const resolved = await resolveTarget(optionalString(args, "session"));
    if (!resolved.ok) {
      answer(resolved.refusal);
      return { outcome: "error", detail: resolved.detail };
    }
    const target = resolved.target;
    const reason = optionalString(args, "reason");
    const instruction =
      instructionOverride ?? `Stop what you are doing and stand down.${reason ? ` ${reason}` : ""}`;
    const label = `stop ${target.name}`;
    gate.hold({
      label,
      askedAfterItemId: lastUserItemId,
      nothingHappened: `${target.name} is still running and was not told anything.`,
      async run() {
        const { result } = await deliver(target, instruction, true);
        return typeof result.instruction === "string"
          ? result.instruction
          : `Told ${target.name} to stop.`;
      },
      failed: (message) =>
        `Telling ${target.name} to stop failed: ${message}. It is still running. Tell the user plainly.`,
    });
    answer({
      status: "awaiting_confirmation",
      session: target.name,
      ...(target.ticket === null ? {} : { ticket: target.ticket }),
      instruction: `Nothing has been sent. Say out loud that you are about to stop ${target.name}${target.ticket === null ? "" : ` on #${target.ticket}`} and that work it has already done may be lost, then ask for a plain yes or no and stop. Their answer is what decides.`,
    });
    return { outcome: "held", detail: label };
  }

  return { steer, stop };
}

/**
 * Which of the three noticed the interruption, as the Call log reports it. Two are guesses about
 * whether a person is talking; the keyboard is not, which is the whole reason they are told apart.
 */
type BargeInHeardBy = "over the speakers" | "the model's voice detection" | "the keyboard";

/**
 * The half-duplex subsystem: what reaches the model's ears, and what happens when the user talks
 * over the reply.
 *
 * One object because it is one policy. Barge-in and echo protection pull in opposite directions —
 * barge-in needs the mic open while the agent speaks, echo protection needs it shut — and the state
 * they argue over is the same handful of facts: how long the queued reply has left to play, how loud
 * the room is, and whether the user has shut the mic themselves. Split across the controller they
 * drifted: the flush cleared the speaker while the window it was gating on stood, and the mic stayed
 * shut through the sentence the user had just interrupted with.
 */
function createMicGate(
  opts: SummonsSessionOptions,
  timers: TimerPort,
  onReport: (report: GateReport) => void,
) {
  const log = opts.callLog ?? NULL_CALL_LOG;
  /** When the audio queued so far will have finished playing out of the speakers. */
  let speakingUntil = 0;
  /** The reply currently coming out of the speakers, as an interruption needs to describe it. */
  let playing: { itemId: string | null; startedAt: number; queuedMs: number } | null = null;
  /** True while the model is still producing the reply, so there is something left to cancel. */
  let generating = false;
  /** When the reply in flight began being generated. Maintained only by `setGenerating`. */
  let generatingSince: number | null = null;
  /** The level the agent's own echo settles at, learned from the frames the echo gate holds back. */
  let echoFloor: number | null = null;
  /** Frames of echo seen so far. Until there are enough, the room is not yet characterised. */
  let framesObserved = 0;
  let loudFrames = 0;
  let lastInterruptAt = Number.NEGATIVE_INFINITY;
  let muted = false;
  /** The level of the most recent frame, so a redraw asked for at any moment has a number to show. */
  let lastLevel = 0;

  /** Hand the status feed what the gate knows. Cheap, and called from everywhere the gate changes. */
  function report(): void {
    onReport({
      muted,
      speaking: timers.now() < speakingUntil,
      generating,
      generatingSince,
      level: muted ? 0 : lastLevel,
      floor: echoFloor,
    });
  }

  /**
   * The one writer of `generating`, so its clock cannot drift from it. Four places turn it on or off
   * — a reply starting, its first audio, its last byte, and a cancel — and the status line needs to
   * know how long the current one has run, which is a fact only the transitions have.
   */
  function setGenerating(on: boolean): void {
    if (on === generating) return;
    generating = on;
    generatingSince = on ? timers.now() : null;
  }

  /**
   * Forget a reply that has finished playing. Nothing pushes this — playback ends by a clock running
   * out, not by an event — so it is asked at the two moments its answer matters. Without it every
   * ordinary turn after a reply reads as an interruption: a speaker flushed with nothing in it, a
   * message truncated that was heard in full, and a barge-in in the Call log that never happened.
   */
  function settle(): void {
    if (!playing || timers.now() < speakingUntil) return;
    playing = null;
    setGenerating(false);
    loudFrames = 0;
  }

  /**
   * Barge-in without echo cancellation, which a WebSocket Realtime session does not have.
   *
   * These are the frames the echo gate is throwing away, so the model will never see them — but
   * their *level* is still worth reading. The echo settles at a floor this tracks; a person talking
   * over it arrives well above that floor. The detector only has to be a hair trigger: once it
   * fires, playback is flushed, the echo stops, and the server's own voice detection does the real
   * work on the rest of the sentence.
   *
   * The frames that triggered it are deliberately not forwarded — they are the user's voice with the
   * agent's mixed under it, and feeding that to transcription buys a garbled turn in exchange for
   * 400ms of opening words. So a one-word "stop" reaches the model as nothing at all, which is the
   * right outcome: what it asked for was silence.
   */
  function detect(pcm: string, level: number): void {
    if (!playing) return;
    /**
     * A frame that *began* before this reply reached the speakers holds no echo — it is the room
     * from before the agent spoke, and it is silence. Reading it as evidence of how loud the echo is
     * put the floor near zero; every real echo frame after that looked like a voice, and since a
     * candidate frame deliberately does not move the floor, it never recovered. Live that was the
     * agent flushing and respawning its own speaker every 400ms for the whole of every reply — a
     * growl out of the speakers, and a perfectly ordinary-looking reply in the log.
     *
     * Frames are ~200ms of history, so at the start of every reply there is exactly one of these.
     * It is not evidence either way: not a floor sample, and not a candidate.
     */
    if (timers.now() - playbackDurationMs(pcm) < playing.startedAt) return;
    if (framesObserved < ECHO_WARMUP_FRAMES) {
      framesObserved += 1;
      echoFloor = Math.max(echoFloor ?? 0, level);
      opts.onDebug?.(
        `echo: learning the room — level ${Math.round(level)}, floor ${Math.round(echoFloor)}`,
      );
      return;
    }
    const floor = echoFloor ?? level;
    if (level > floor * BARGE_IN_RATIO && level > BARGE_IN_MIN_LEVEL) {
      loudFrames += 1;
      opts.onDebug?.(
        `echo: candidate ${loudFrames}/${BARGE_IN_FRAMES} — level ${Math.round(level)} over floor ${Math.round(floor)}`,
      );
      if (loudFrames < BARGE_IN_FRAMES) return;
      if (timers.now() - lastInterruptAt < BARGE_IN_COOLDOWN_MS) {
        opts.onDebug?.("echo: within the cooldown, so not treated as an interruption");
        return;
      }
      gate.interrupt("over the speakers");
      return;
    }
    // Only frames that are *not* candidates move the floor, or a voice would pull the threshold up
    // behind itself and the second frame would never clear it.
    echoFloor =
      echoFloor === null ? level : echoFloor * (1 - ECHO_FLOOR_WEIGHT) + level * ECHO_FLOOR_WEIGHT;
    loudFrames = 0;
  }

  const gate = {
    /** A slice of the reply to play, and the clock that decides when the mic may open again. */
    queuePlayback(pcm: string, itemId: string | null): void {
      // Deltas arrive faster than they play, so this slice starts when whatever is already queued
      // runs out — which is also the moment the reply it belongs to began reaching the room.
      const startsAt = Math.max(speakingUntil, timers.now());
      const duration = playbackDurationMs(pcm);
      if (playing && playing.itemId === itemId) {
        playing.queuedMs += duration;
      } else {
        playing = { itemId, startedAt: startsAt, queuedMs: duration };
      }
      speakingUntil = startsAt + duration;
      setGenerating(true);
      opts.audio?.play(pcm);
      report();
    },

    /**
     * The server has started a reply. Known so an interruption arriving before the first audio does
     * cancels the reply rather than silently doing nothing — which is also what makes a typed turn
     * sent in that window safe, since the API refuses a second ask while a response is in flight.
     */
    replyStartedGenerating(): void {
      setGenerating(true);
      report();
    },

    replyFinishedGenerating(): void {
      setGenerating(false);
      // Every byte of the reply is in, so the speaker is told where it ends — which is what lets it
      // play the last syllable rather than holding it back waiting for audio that will never come.
      opts.audio?.endReply();
      report();
    },

    /**
     * Whether a mic frame reaches the model. Every reason to hold it back is decided here together:
     * the user muted it, or the agent is still audible in the room.
     */
    admit(pcm: string): void {
      if (muted) {
        report();
        return;
      }
      settle();
      // Read once, here, whether the frame is going to the model or being held back to be measured:
      // it is the same number either way, and the status line wants it either way.
      const level = peakLevel(pcm);
      lastLevel = level;
      // Judged on when the frame *began*, not when it arrived. A frame is ~200ms of history, so the
      // first frame admitted after the window closed still opens inside it — and one frame of the
      // agent's own voice is all the model's voice detection needs to make it interrupt itself.
      if (
        !opts.headphones &&
        timers.now() - playbackDurationMs(pcm) < speakingUntil + PLAYBACK_TAIL_MS
      ) {
        detect(pcm, level);
        report();
        return;
      }
      loudFrames = 0;
      opts.transport.sendAudio(pcm);
      report();
    },

    /**
     * The user is talking over the agent — one path, whichever detector noticed. Answers whether
     * there was anything to cut off, because `Esc` has a second meaning when there is not (it
     * clears the input line) and only the gate knows which of the two happened.
     */
    interrupt(heardBy: BargeInHeardBy): boolean {
      settle();
      // `--no-barge-in` suppresses the two detectors that guess, and only those: a keypress is
      // explicit intent, and a flag about how eagerly a room is listened to has no say over it.
      if (opts.bargeIn === false && heardBy !== "the keyboard") {
        opts.onDebug?.(`echo: heard an interruption (${heardBy}), but barge-in is off`);
        return false;
      }
      /**
       * A reply nobody has heard yet can only be cancelled from the keyboard.
       *
       * There are two windows. Once audio is queued, any source may cut in — that is barge-in as it
       * has always been. Before the first syllable reaches the room the reply is still cancellable,
       * and `Esc` (or a typed turn, which has to cancel or the API refuses its ask) must be able to,
       * because a person who has changed their mind should not have to wait to be spoken to first.
       *
       * The two detectors must not. Both *guess* whether a person is talking, and the gap between
       * "the user stopped speaking" and "the first audio delta" is a gap with the mic wide open and
       * nothing queued to hold it shut — so a breath, a chair, or the user's own trailing word trips
       * the server's voice detection and kills the answer to the question they just asked. Observed
       * live: ask a question, get silence. A guess may interrupt something the user can hear and
       * judge; it may not silently discard a reply they never got.
       */
      if (!playing && !(generating && heardBy === "the keyboard")) return false;
      // A reply the model has finished generating has nothing left to cancel, and asking anyway is
      // an API error the user would be told about for no reason. The queued audio still has to go.
      if (generating) opts.transport.cancelResponse();
      if (playing?.itemId) {
        const heard = Math.min(Math.max(0, timers.now() - playing.startedAt), playing.queuedMs);
        opts.transport.truncateAudio(playing.itemId, Math.round(heard));
      }
      opts.audio?.flush();
      // Cleared together with the flush, which is the coupling this whole object exists to hold in
      // one place: the queued audio the mic was being held back for no longer exists, so a window
      // left standing would swallow the sentence the user interrupted with.
      speakingUntil = 0;
      playing = null;
      setGenerating(false);
      loudFrames = 0;
      lastInterruptAt = timers.now();
      opts.onDebug?.(`echo: cut the reply off (${heardBy})`);
      log.record({
        type: "note",
        level: "info",
        // Nobody talked over anything when the interruption came from a key, and a log that says
        // they did reads as the echo detector having fired.
        text:
          heardBy === "the keyboard"
            ? "The reply was cut off from the keyboard."
            : `The user talked over the reply and it was cut off (${heardBy}).`,
      });
      report();
      return true;
    },

    toggleMute(): boolean {
      muted = !muted;
      // Recorded, because a stretch where the user said nothing and a stretch where the mic was shut
      // are indistinguishable in the log otherwise.
      log.record({
        type: "note",
        level: "info",
        text: muted
          ? "The mic was muted. Input is suspended until it is unmuted; the idle window keeps running."
          : "The mic was unmuted.",
      });
      report();
      return muted;
    },
  };

  return gate;
}

/**
 * The one thing about a tool call worth reading at a glance — the path, the pattern, the label.
 * Best-effort by design: an unparseable argument blob is a thing to record, not to fail on.
 */
function toolTarget(name: string, rawArgs: string): string {
  let args: Record<string, unknown>;
  try {
    args = parseArgs(rawArgs, name);
  } catch {
    return "(unreadable arguments)";
  }
  for (const key of ["path", "pattern", "label"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export function createSummonsSession(opts: SummonsSessionOptions): SummonsSession {
  const timers = opts.timers ?? realTimers;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_SUMMONS_IDLE_TIMEOUT_MS;
  const log = opts.callLog ?? NULL_CALL_LOG;
  // Declared before the collaborators below, because their callbacks read it. A `let` read during
  // construction would be a temporal-dead-zone crash, and the one place that would surface is a
  // live conversation.
  let stopped = false;
  let idleHandle: unknown = null;
  /** The mic half of the status, as the gate last reported it. */
  let gateReport: GateReport = {
    muted: false,
    speaking: false,
    generating: false,
    generatingSince: null,
    level: 0,
    floor: null,
  };
  /** The tool call in flight, if there is one. What "working" is working on. */
  let working: { tool: string; since: number } | null = null;

  /**
   * Announcements waiting for the reply in flight to finish. The API refuses a second ask while a
   * response is active, and unlike a typed turn — where cancelling is right, because the person has
   * already moved on — news can wait. Cutting the agent off mid-sentence to interrupt with something
   * nobody asked for is the one reading of this that would be rude.
   *
   * One at a time: flushing the queue in a burst would collide with itself on the second ask.
   */
  const waitingToBeSaid: string[] = [];

  const gate = createGate(opts);
  const delegations = createDelegations(opts, gate, timers, (finished) => {
    reportStatus();
    /**
     * A Summons waiting on work it asked for is not idle.
     *
     * The idle window is armed by what the *server* reports — speech, a reply, a tool call — and a
     * delegated session runs for minutes with none of those happening. So a Summons hung itself up
     * on the very thing it was waiting for, and the announcement below could never arrive: observed
     * live. Every roster change re-arms it, and the watch loop makes one on every poll for as long
     * as anything is still running.
     *
     * The consequence, stated plainly: a delegated session that runs for hours keeps its Summons
     * open for hours. That is the right way round — hanging up on the work you are waiting for is
     * worse than a socket left open — but the idle window no longer bounds a forgotten Summons whose
     * delegate is stuck.
     */
    markActive();
    if (!finished) return;
    announce(
      `The session "${finished.session}" you delegated as "${finished.label}" has just finished. ` +
        "Tell the user now, in one short sentence, and offer to go through what it did. " +
        `The last thing it said was: ${finished.latest ?? "(nothing it said was readable)"}` +
        (finished.alsoStarted
          ? ` That freed its repo, so the queued task "${finished.alsoStarted}" has started.`
          : ""),
    );
  });
  // Steering needs all three: a registry to resolve a name against, a hub to check the Claim on,
  // and hands to relay through. Missing any one, the tools are not offered at all (below).
  const steering = createSteering(opts, gate, timers);
  const filing = createFiling(opts, gate);
  /**
   * The two halves of the status line, joined here because this is the only place that holds both.
   *
   * `working` beats `speaking` beats `thinking`: a named tool is more use than "busy", and audible
   * beats being composed because the user can hear the difference themselves.
   */
  function reportStatus(): void {
    if (!opts.onStatus) return;
    const doing = working
      ? "working"
      : gateReport.speaking
        ? "speaking"
        : gateReport.generating
          ? "thinking"
          : "listening";
    const since = working ? working.since : (gateReport.generatingSince ?? 0);
    opts.onStatus({
      muted: gateReport.muted,
      doing,
      ...(working ? { tool: working.tool } : {}),
      forMs: doing === "working" || doing === "thinking" ? Math.max(0, timers.now() - since) : 0,
      level: gateReport.level,
      floor: gateReport.floor,
      delegations: delegations.roster(),
    });
  }

  /** The only thing a Summons says unbidden. */
  function announce(text: string): void {
    if (stopped) return;
    if (gateReport.generating) {
      waitingToBeSaid.push(text);
      return;
    }
    opts.transport.promptAgent(text);
  }

  const mic = createMicGate(opts, timers, (report) => {
    gateReport = report;
    reportStatus();
  });
  /** Numbers already handed out, so the next call gets one no earlier call had. */
  let toolCalls = 0;
  /** The utterance the server is currently hearing — the gate's evidence of what came from where. */
  let lastUserItemId: string | null = null;

  /**
   * What is running, as the agent should say it. An unreadable registry is reported as unknown and
   * never as an empty list: "I cannot tell" is a true answer and "nothing is running" is not.
   */
  async function listSessions(): Promise<Record<string, unknown>> {
    if (!opts.sessions) return { error: "This Summons cannot see what else is running." };
    const report = await opts.sessions.list();
    if (!report.known) {
      return {
        known: false,
        instruction:
          "This machine's session registry could not be read, so you do not know what is running. Say that — do not say nothing is running.",
      };
    }
    return { known: true, count: report.sessions.length, sessions: report.sessions };
  }

  /**
   * One round trip to the Hands session. The record is written whatever happened — a request that
   * failed is exactly the case the user cannot see any other way, so the failure goes where the
   * answer would have gone.
   */
  async function handleHandsCall(
    call: Extract<RealtimeInbound, { type: "tool_call" }>,
    startedAt: number,
  ): Promise<void> {
    let request = "";
    const fail = (detail: string) => {
      opts.transport.sendToolResult(call.callId, JSON.stringify({ error: detail }));
      log.record({
        type: "hands",
        request,
        response: detail,
        outcome: "error",
        durationMs: timers.now() - startedAt,
      });
    };
    try {
      request = requireString(parseArgs(call.args, call.name), "request", call.name);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!opts.hands) {
      fail("This Summons has no hands — it was started without a Hands session.");
      return;
    }
    // Recorded before the call goes out, not after it returns. A round trip can run for minutes,
    // and until this line existed the live view showed nothing at all while it did — the user
    // heard "just a moment" and had no way to tell working from hung.
    log.record({ type: "hands-asked", request });
    try {
      const answer = await opts.hands.ask(request);
      opts.transport.sendToolResult(call.callId, JSON.stringify({ answer }));
      log.record({
        type: "hands",
        request,
        response: answer,
        outcome: "ok",
        durationMs: timers.now() - startedAt,
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // Tool failures are conversation, not crashes: the agent hears what went wrong and can say so.
  async function handleToolCall(call: Extract<RealtimeInbound, { type: "tool_call" }>) {
    const startedAt = timers.now();
    // Said before the work, not after it. A tool call is recorded when it *finishes*, which is the
    // right thing for a record and useless while you are waiting — a Summons spawning a session or
    // reading a transcript looked exactly like one that had gone quiet. The status line says which,
    // by name, for as long as it takes.
    working = { tool: call.name, since: startedAt };
    reportStatus();
    try {
      await runToolCall(call, startedAt);
    } finally {
      working = null;
      reportStatus();
    }
  }

  async function runToolCall(
    call: Extract<RealtimeInbound, { type: "tool_call" }>,
    startedAt: number,
  ) {
    // Every tool call is recorded, whatever it did — the point of the Call log is that nothing the
    // agent does on the user's behalf happens invisibly. `result` reaches this only from the calls
    // the controller answers itself; the rest is explained on the entry kind.
    const recordCall = ({ outcome, detail }: ToolOutcome, result?: string) => {
      toolCalls += 1;
      log.record({
        type: "tool",
        name: call.name,
        target: toolTarget(call.name, call.args),
        outcome,
        durationMs: timers.now() - startedAt,
        number: toolCalls,
        ...(call.args ? { args: recordedText(call.args) } : {}),
        ...(detail ? { detail } : {}),
        ...(result === undefined ? {} : { result: recordedText(result) }),
      });
    };

    // The Hands session is recorded as a `hands` entry rather than a `tool` one: what was asked and
    // what came back *is* the record of the call, and the round trip is the only trace a session
    // with no tab leaves anywhere (workspace ADR 0010).
    if (call.name === "ask_hands") {
      await handleHandsCall(call, startedAt);
      return;
    }

    // `delegate` and `research` answer their own call — the first from inside the gate once the
    // user has spoken, the second as soon as it has launched. Neither returns a result here.
    if (call.name === "delegate") {
      recordCall(delegations.propose(call.callId, call.args, lastUserItemId));
      return;
    }
    if (call.name === "research") {
      recordCall(await delegations.research(call.callId, call.args));
      return;
    }
    // Steering writes its own `steer` entries once it reaches the relay — what was sent and
    // whether it landed is the record of the call, the same way `ask_hands` is. A call that never
    // got that far leaves no `steer` entry, so it is recorded as a plain tool call instead:
    // an instruction refused for scope is exactly what the user needs to see in the log.
    if (call.name === "steer_session") {
      const outcome = await steering.steer(call.callId, call.args, lastUserItemId);
      if (!outcome.relayed) recordCall(outcome);
      return;
    }
    if (call.name === "stop_session") {
      recordCall(await steering.stop(call.callId, call.args, lastUserItemId));
      return;
    }
    if (call.name === "file_ticket") {
      recordCall(filing.propose(call.callId, call.args, lastUserItemId));
      return;
    }
    let result: Record<string, unknown>;
    try {
      result =
        call.name === "check_delegation"
          ? await delegations.observe(call.args)
          : call.name === "list_sessions"
            ? await listSessions()
            : await runTool(opts.reader, call.name, call.args);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    const output = JSON.stringify(result);
    opts.transport.sendToolResult(call.callId, output);
    const failure = typeof result.error === "string" ? result.error : null;
    recordCall(failure ? { outcome: "error", detail: failure } : { outcome: "ok" }, output);
  }

  async function stop(reason: CallLogEndReason = "hung up"): Promise<void> {
    if (stopped) return;
    stopped = true;
    // The Hands session belongs to the conversation, not the machine — one that outlived its
    // Summons would belong to nobody. Ended before the record is closed off, so a session that
    // will not die lands in the log rather than after the end of it; and swallowed, because a
    // Summons that cannot hang up is worse than a stray headless session.
    try {
      await opts.hands?.end();
    } catch (err) {
      log.record({
        type: "note",
        level: "error",
        text: `The Hands session did not end cleanly: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    log.record({ type: "ended", reason });
    delegations.stopWatching();
    timers.clearTimeout(idleHandle);
    idleHandle = null;
    await opts.audio?.stop();
    await opts.transport.close();
    opts.onStopped?.();
  }

  function markActive(): void {
    if (stopped || idleTimeoutMs <= 0) return;
    timers.clearTimeout(idleHandle);
    idleHandle = timers.setTimeout(() => void stop("idle"), idleTimeoutMs);
  }

  async function handleInbound(event: RealtimeInbound): Promise<void> {
    markActive();
    switch (event.type) {
      case "tool_call":
        await handleToolCall(event);
        return;
      case "audio":
        mic.queuePlayback(event.pcm, event.itemId ?? null);
        return;
      case "reply_started":
        mic.replyStartedGenerating();
        return;
      case "reply_done": {
        mic.replyFinishedGenerating();
        // Now, and not before: the ask below is the second one the API would have refused.
        const waited = waitingToBeSaid.shift();
        if (waited !== undefined) announce(waited);
        return;
      }
      case "error":
        log.record({ type: "note", level: "error", text: event.message });
        opts.onError?.(event.message);
        return;
      case "closed":
        await stop("closed");
        return;
      case "user_speaking":
        lastUserItemId = event.itemId ?? null;
        // In headphone mode this is the only detector there is; with speakers the mic is gated, so
        // it fires for a frame admitted just before playback began. Either way it is the same answer.
        mic.interrupt("the model's voice detection");
        return;
      case "user_transcript":
        log.record({ type: "said", who: "user", text: event.text });
        // Where a heard word decides something: releasing whatever the gate is holding. A typed
        // one does it too, through the same call (`typed`).
        await gate.resolve(event.text, event.itemId ?? null);
        delegations.remember("user", event.text);
        return;
      case "assistant_transcript":
        log.record({ type: "said", who: "servant", text: event.text });
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
          // Each group is offered only when there is something behind it, so the agent is never
          // holding a tool that cannot work.
          tools: [
            ...SUMMONS_TOOLS,
            ...(opts.actions ? DELEGATION_TOOLS : []),
            ...(opts.hands ? HANDS_TOOLS : []),
            ...(opts.sessions ? SESSIONS_TOOLS : []),
            ...(opts.hands && opts.sessions && opts.tickets ? STEER_TOOLS : []),
            ...(opts.filing ? TICKET_TOOLS : []),
          ],
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
      await opts.audio?.startCapture((pcm) => mic.admit(pcm));
      if (stopped) {
        await opts.audio?.stop();
        return;
      }
      markActive();
    },

    toggleMute: () => mic.toggleMute(),

    async typed(text) {
      const utterance = text.trim();
      if (stopped || !utterance) return;
      // Typing is conversation, so it re-arms the idle window: a Summons being typed at for an hour
      // with the mic muted is not a Summons that has been abandoned.
      markActive();
      /**
       * Typing over a reply cuts the reply off, exactly as `Esc` would.
       *
       * A typed turn asks for an answer, and the API refuses a second ask while a response is in
       * flight — so this had to be decided one of three ways: cancel the reply, queue the ask until
       * the reply is over, or send the words without asking. Cancelling is the only one that
       * matches what the person did. They were listening, they started typing instead, and they
       * pressed enter: that is a barge-in in every sense but the microphone, and the keyboard is
       * the one barge-in source that is never a guess (ADR-009). Queueing would let the agent
       * finish saying something already overtaken and then answer late; sending without asking
       * would leave the line sitting unanswered until something else provoked a reply, which reads
       * as the Summons having ignored you.
       *
       * The Call log says the keyboard cut it off, which is true and is also the trail back to why
       * the reply stops mid-sentence in the transcript.
       */
      mic.interrupt("the keyboard");
      // Recorded before it is sent, so a turn that dies on the way out is still in the record.
      log.record({ type: "said", who: "user", text: utterance, channel: "typed" });
      opts.transport.sendUserText(utterance);
      // Everything below is what a heard turn does, in the same order, because a typed turn is the
      // same turn. No item id: the stale-utterance guard exists for transcription lag, and there is
      // none — what was typed was typed now.
      await gate.resolve(utterance, null);
      delegations.remember("user", utterance);
    },

    interrupt() {
      // Guarded like `typed`: a key pressed after the hang-up would otherwise put a barge-in in the
      // record below the line that says the Summons ended.
      return stopped ? false : mic.interrupt("the keyboard");
    },

    note: (text, level = "error") => log.record({ type: "note", level, text }),

    // Only the controller knows why a session ended, and the record wants that — so the reason is
    // internal, and everyone outside is hanging up.
    stop: () => stop("hung up"),
  };
}
