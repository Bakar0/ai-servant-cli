import { requireAudioTool } from "./summons-preflight.ts";
import type { AudioPort } from "./summons.ts";

// Microphone and speaker for a Summons, built on two long-lived `sox` subprocesses. Chosen
// over a native audio addon because servant ships as a compiled Bun single-file binary, which
// native addons break (workspace ADR 0009). macOS-first; this is the seam's outside. What is handed
// to `sox` and when is pinned by the suite through the spawn seam below; how it sounds coming out of
// the device is verified by hand, because nothing else can.

/** The Realtime API's wire format on a WebSocket: 24 kHz mono little-endian signed 16-bit PCM. */
const SAMPLE_RATE = 24_000;
const RAW_PCM_ARGS = [
  "-t",
  "raw",
  "-b",
  "16",
  "-e",
  "signed-integer",
  "-r",
  String(SAMPLE_RATE),
  "-c",
  "1",
];
/** ~200 ms of audio — the chunk size the Realtime API is happiest receiving. */
const CHUNK_BYTES = (SAMPLE_RATE / 5) * 2;

/**
 * How much of a reply to have in hand before starting the speaker.
 *
 * A `sox` started before there is anything to play opens the output device and then starves it,
 * and the device does not recover cleanly when audio finally arrives: the first second or so comes
 * out as a growl and then clears up. Heard live as "growling, fox jumping something, one two three
 * four five" — mangled at the start, perfect by the end — and on a short reply that is the whole of
 * it. Handing sox a cushion at the moment it opens the device is what makes the first syllable sound
 * like the last one.
 *
 * It costs almost no latency: deltas arrive far faster than real time, so this much audio is in hand
 * within a frame or two of the reply starting.
 */
const SPEAKER_PRIME_BYTES = (SAMPLE_RATE / 1000) * 600 * 2;

/** A `sox` recording the microphone: PCM on stdout, and a death worth reporting. */
export interface RecorderProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

/** A `sox` playing one reply: PCM in on stdin, ended to make it drain and exit. */
export interface SpeakerProcess {
  readonly stdin: { write(chunk: Uint8Array): unknown; end(): unknown };
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

/**
 * The subprocess seam.
 *
 * Everything this module knows about audio quality is a claim about *what is handed to `sox` and
 * when* — how much is behind the device before it opens, that a reply gets a speaker of its own,
 * that stdin is closed rather than the process killed. All of that is checkable without a sound
 * card; only the sound itself is not. So the spawn is injectable and the invariants are tested,
 * while the device stays hand-verified.
 */
export interface AudioProcesses {
  recorder(args: string[]): RecorderProcess;
  speaker(args: string[]): SpeakerProcess;
}

/** The real thing: two long-lived `sox` subprocesses, with the tool resolved up front. */
function soxProcesses(): AudioProcesses {
  const sox = requireAudioTool((command) => Bun.which(command));
  return {
    recorder: (args) =>
      Bun.spawn([sox, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }) as unknown as RecorderProcess,
    speaker: (args) =>
      Bun.spawn([sox, ...args], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      }) as unknown as SpeakerProcess,
  };
}

export interface SoxAudioOptions {
  /** Called when a `sox` process dies on its own — the session is deaf or mute from then on. */
  onFailure?: ((message: string) => void) | undefined;
  onDebug?: ((message: string) => void) | undefined;
  /** Injected by the suite; the default resolves `sox` on PATH and fails preflight without it. */
  processes?: AudioProcesses | undefined;
}

export function createSoxAudio(opts: SoxAudioOptions = {}): AudioPort {
  const processes = opts.processes ?? soxProcesses();
  let recorder: RecorderProcess | null = null;
  let speaker: SpeakerProcess | null = null;
  /**
   * Every speaker not yet reaped, including ones left draining the end of a reply. Tracked because
   * `stop()` has to end their stdin and wait for them: an open FileSink and an unreaped child both
   * keep the process alive, and a `servant summon` that will not exit is worse than a silent one.
   */
  const alive = new Set<SpeakerProcess>();
  let pump: Promise<void> | null = null;
  let stopping = false;
  /** The head of the current reply, held back only until there is enough of it to open with. */
  const priming: Buffer[] = [];
  let primingBytes = 0;

  /**
   * Watch a `sox` we did not kill or retire ourselves. Silence here is what makes this layer's
   * failures invisible: the mic dying mid-conversation looks exactly like the user having gone quiet.
   */
  function watch(
    role: string,
    proc: { stderr: ReadableStream<Uint8Array>; exited: Promise<number> },
    retired: () => boolean = () => false,
  ): void {
    void (async () => {
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (stopping || retired()) return;
      const detail = stderr.trim() || `exit code ${code}`;
      opts.onFailure?.(`the ${role} (sox) stopped: ${detail}`);
    })();
  }

  /**
   * Start a speaker for a reply, handing it everything gathered so far.
   *
   * One sox per reply, fed on stdin. The obvious shape — one long-lived sox reading a FIFO — is what
   * this replaces, and it was wrong in three ways that sounded like three different bugs. Its input
   * buffer had to be tiny (1024 bytes, 21ms) so playback would keep pace with the controller's
   * estimate of it; that left 21ms of read-ahead, so every gap between the 200ms bursts arriving off
   * the socket starved the output device, and dozens of dropouts a second is a growl rather than
   * speech. Writes went into a 64KB pipe, so a long reply applied backpressure to the socket. And
   * because a FIFO needs a reader held open to avoid EOF, *we* held one — so a speaker that died left
   * our writes blocking on a pipe nobody would ever read again, and the Summons went mute reporting
   * nothing.
   *
   * Bun's FileSink buffers in user space, so a whole reply is accepted immediately and sox is fed as
   * fast as it can read: it cannot starve, and the socket never waits for the speaker. Closing stdin
   * at the end of a reply makes sox drain and exit, which is also what plays the last syllable that
   * the old input buffer used to hold back.
   */
  function startSpeaker(primed: Buffer): SpeakerProcess {
    const proc = processes.speaker(["-q", ...RAW_PCM_ARGS, "-", "-d"]);
    speaker = proc;
    alive.add(proc);
    void proc.exited.then(() => alive.delete(proc));
    // Written before anything else can be: the device opens with a cushion behind it, which is the
    // whole point of priming.
    void proc.stdin.write(primed);
    opts.onDebug?.(`speaker: started with ${(primed.length / 2 / SAMPLE_RATE).toFixed(2)}s primed`);
    // Exiting once its stdin is closed is the design, not a failure — so a speaker that is no
    // longer the current one is retired, and its exit is expected.
    watch("speaker", proc, () => speaker !== proc);
    return proc;
  }

  /** Re-chunk sox's arbitrary-sized reads into the frame size the API wants. */
  async function drainMic(stdout: ReadableStream<Uint8Array>, onChunk: (pcm: string) => void) {
    let pending = new Uint8Array(0);
    let frames = 0;
    for await (const chunk of stdout) {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      let offset = 0;
      while (merged.length - offset >= CHUNK_BYTES) {
        onChunk(Buffer.from(merged.subarray(offset, offset + CHUNK_BYTES)).toString("base64"));
        offset += CHUNK_BYTES;
        // One line per ~10s of mic, enough to tell "the mic died" from "nobody spoke".
        if (++frames % 50 === 0) opts.onDebug?.(`mic: ${frames} frames sent`);
      }
      pending = merged.slice(offset);
    }
    opts.onDebug?.(`mic: input stream ended after ${frames} frames`);
  }

  /** Everything gathered for a reply whose speaker has not started yet. */
  function takePriming(): Buffer {
    const gathered = Buffer.concat(priming);
    priming.length = 0;
    primingBytes = 0;
    return gathered;
  }

  /** Retire the current speaker, either letting it finish or cutting it off. */
  function release(mode: "drain" | "cut"): void {
    const retiring = speaker;
    if (!retiring) return;
    speaker = null;
    // Ended in both cases: an unended FileSink holds a file descriptor open, and enough of those
    // is a Summons that has hung up but will not exit.
    void retiring.stdin.end();
    if (mode === "cut") retiring.kill();
  }

  return {
    startCapture(onChunk) {
      // `-d` records from the default input device. The mic stays open for the life of the session
      // — nothing is gated on a keypress, so the keyboard is never captured.
      recorder = processes.recorder(["-q", "-d", ...RAW_PCM_ARGS, "-"]);
      opts.onDebug?.("mic: recorder started");
      watch("microphone", recorder);
      pump = drainMic(recorder.stdout, onChunk).catch((err: unknown) => {
        if (!stopping) opts.onFailure?.(`the microphone stream failed: ${String(err)}`);
      });
      return Promise.resolve();
    },

    play(pcm) {
      const bytes = Buffer.from(pcm, "base64");
      // Never awaited: the FileSink takes the whole reply into user space, so this cannot block the
      // socket that is still receiving it.
      if (speaker) {
        void speaker.stdin.write(bytes);
        return;
      }
      priming.push(bytes);
      primingBytes += bytes.length;
      if (primingBytes < SPEAKER_PRIME_BYTES) return;
      startSpeaker(takePriming());
    },

    endReply() {
      // A reply shorter than the priming cushion has to be played anyway, not held for audio that
      // is never coming.
      if (!speaker && primingBytes > 0) startSpeaker(takePriming());
      release("drain");
    },

    flush() {
      release("cut");
      takePriming();
      opts.onDebug?.("speaker: queued playback flushed");
    },

    async stop() {
      stopping = true;
      recorder?.kill();
      recorder = null;
      speaker = null;
      // Every speaker, not just the current one — a reply left draining is still a live child, and
      // an unreaped child keeps the whole process alive.
      const dying = [...alive];
      alive.clear();
      for (const proc of dying) {
        void proc.stdin.end();
        proc.kill();
      }
      await Promise.all(dying.map((proc) => proc.exited));
      await pump;
      pump = null;
    },
  };
}
