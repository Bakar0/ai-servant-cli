// A Summons: a live spoken conversation with a servant workspace. The controller here is the
// single seam the feature is tested at — the Realtime socket, the sox audio pipes and the
// filesystem all sit outside it as injected ports (see workspace ADR 0009).

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
  | { type: "user_speaking" }
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

async function runTool(
  reader: WorkspaceReader,
  name: string,
  rawArgs: string,
): Promise<Record<string, unknown>> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArgs || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not JSON");
    args = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse the arguments to ${name}.`);
  }
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

export function createSummonsSession(opts: SummonsSessionOptions): SummonsSession {
  const timers = opts.timers ?? realTimers;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_SUMMONS_IDLE_TIMEOUT_MS;
  let idleHandle: unknown = null;
  let stopped = false;
  /** When the audio queued so far will have finished playing out of the speakers. */
  let speakingUntil = 0;

  // Tool failures are conversation, not crashes: the agent hears what went wrong and can say so.
  async function handleToolCall(call: Extract<RealtimeInbound, { type: "tool_call" }>) {
    let result: Record<string, unknown>;
    try {
      result = await runTool(opts.reader, call.name, call.args);
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
      default:
        return; // user_speaking / assistant_transcript are activity signals and nothing more
    }
  }

  return {
    async start() {
      await opts.transport.connect(
        {
          model: opts.model || DEFAULT_SUMMONS_MODEL,
          voice: opts.voice || DEFAULT_SUMMONS_VOICE,
          instructions: opts.instructions,
          tools: SUMMONS_TOOLS,
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
