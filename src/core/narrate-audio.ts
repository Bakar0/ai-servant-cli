import { NARRATION_SAMPLE_RATE } from "./narrate-voice.ts";

// Sound out. One `sox` per playback run, fed PCM on stdin — the same shape a Summons reply uses,
// for the same reason: servant ships as a compiled Bun binary and a native audio addon does not
// survive that (workspace ADR 0009).
//
// A run ends at every Transport action. Pausing, seeking, skipping a Segment and changing tempo are
// all "stop this `sox` and open another one at the new position", because the alternative — one
// long-lived process being steered — is a process that has already buffered the seconds you just
// asked it to skip. Killing it is what makes ← feel immediate instead of feeling like a request.

// Spelled out again rather than shared with `summons-audio.ts`, whose numbers are identical today.
// They are two independent contracts that happen to agree: that one is the Realtime socket's wire
// format, this one is what `/v1/audio/speech` returns for `response_format: "pcm"`. Either endpoint
// could move without the other, and a shared constant would carry the change silently.
const RAW_PCM_ARGS = [
  "-t",
  "raw",
  "-b",
  "16",
  "-e",
  "signed-integer",
  "-r",
  String(NARRATION_SAMPLE_RATE),
  "-c",
  "1",
];

/** The fstat-on-a-socket trap, in full in `summons-audio.ts`. The same stdin is the same trap. */
const IGNORE_INPUT_LENGTH = "--ignore-length";

/**
 * How much `sox` is allowed to hold. Small, because the on-screen position is wall-clock arithmetic
 * and everything still inside `sox` is time the position has counted and the ear has not yet heard.
 * ~85 ms at this rate, which keeps that lie well under the 200 ms the ticket budgets for a gap.
 */
const DEVICE_BUFFER_BYTES = 4096;

/**
 * Tempo, as a playback effect rather than a synthesis parameter.
 *
 * The speech API bakes speed in at synthesis time, which would make the rate part of the cache key
 * and re-synthesize the whole Turn every time you pressed `]`. `sox`'s `tempo` costs nothing, keeps
 * the pitch, and is the single biggest lever there is on how long a Narration takes to listen to.
 */
export function tempoArgs(tempo: number): string[] {
  // `tempo` at 1.0 is not free — it still runs the time-stretcher over every sample, and the
  // artefacts are audible on speech. At normal speed there is nothing to stretch, so it is left out.
  return Math.abs(tempo - 1) < 0.001 ? [] : ["tempo", "-s", tempo.toFixed(2)];
}

/** A `sox` playing one run: PCM in on stdin, ended to make it drain and exit. */
export interface PlaybackProcess {
  readonly stdin: { write(chunk: Uint8Array): unknown; end(): unknown };
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

/** The subprocess seam. Everything above it is testable without a sound card. */
export interface PlaybackProcesses {
  play(args: string[]): PlaybackProcess;
}

/** One run of playback: bytes in until it is ended or killed. */
export interface PlaybackRun {
  write(pcm: Uint8Array): void;
  /** Close stdin and wait for the device to drain — the ordinary end of a Narration. */
  finish(): Promise<void>;
  /** Stop now. What every Transport key does before the next run opens. */
  kill(): void;
  readonly exited: Promise<number>;
}

export interface NarrationSpeaker {
  open(tempo: number): PlaybackRun;
}

export interface SoxSpeakerOptions {
  processes?: PlaybackProcesses;
  /** Called when a run died on its own. The Player turns this into a visible pause, never silence. */
  onLost?: (message: string) => void;
}

function soxProcesses(): PlaybackProcesses {
  const sox = Bun.which("sox");
  if (!sox) {
    throw new Error("`sox` is not on PATH — narration needs it (e.g. `brew install sox`).");
  }
  return {
    play: (args) =>
      Bun.spawn([sox, ...args], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      }) as unknown as PlaybackProcess,
  };
}

export function createSoxSpeaker(options: SoxSpeakerOptions = {}): NarrationSpeaker {
  const processes = options.processes ?? soxProcesses();
  return {
    open(tempo) {
      const proc = processes.play([
        ...RAW_PCM_ARGS,
        IGNORE_INPUT_LENGTH,
        "--buffer",
        String(DEVICE_BUFFER_BYTES),
        "-",
        "-d",
        ...tempoArgs(tempo),
      ]);
      let done = false;
      // A run that dies under a Narration is a Segment the listener never hears. Reported rather
      // than swallowed: the whole point of "pause and show it" is that silence is never the answer.
      void (async () => {
        const [code, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text().catch(() => ""),
        ]);
        if (!done && code !== 0) {
          options.onLost?.(`playback (sox) stopped: ${stderr.trim() || `exit code ${code}`}`);
        }
      })();
      return {
        write(pcm) {
          if (done) return;
          try {
            proc.stdin.write(pcm);
          } catch {
            // The process is gone; its `exited` watcher above is what says so.
          }
        },
        async finish() {
          if (done) return;
          done = true;
          try {
            proc.stdin.end();
          } catch {
            // Already closed.
          }
          await proc.exited;
        },
        kill() {
          done = true;
          proc.kill();
        },
        exited: proc.exited,
      };
    },
  };
}
