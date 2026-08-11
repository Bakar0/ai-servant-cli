import { requireAudioTool } from "./summons-preflight.ts";
import type { AudioPort } from "./summons.ts";

// Microphone and speaker for a Summons, built on two long-lived `sox` subprocesses. Chosen
// over a native audio addon because servant ships as a compiled Bun single-file binary, which
// native addons break (workspace ADR 0009). macOS-first; this is the seam's outside, verified by
// hand rather than in the test suite.

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

export interface SoxAudioOptions {
  /** Called when a `sox` process dies on its own — the session is deaf or mute from then on. */
  onFailure?: ((message: string) => void) | undefined;
  onDebug?: ((message: string) => void) | undefined;
}

export function createSoxAudio(opts: SoxAudioOptions = {}): AudioPort {
  const sox = requireAudioTool((command) => Bun.which(command));
  let recorder: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let speaker: Bun.Subprocess<"pipe", "ignore", "pipe"> | null = null;
  /**
   * Every speaker not yet reaped, including ones left draining the end of a reply. Tracked because
   * `stop()` has to end their stdin and wait for them: an open FileSink and an unreaped child both
   * keep the process alive, and a `servant summon` that will not exit is worse than a silent one.
   */
  const alive = new Set<Bun.Subprocess<"pipe", "ignore", "pipe">>();
  let pump: Promise<void> | null = null;
  let stopping = false;

  /**
   * Watch a `sox` we did not kill or retire ourselves. Silence here is what makes this layer's
   * failures invisible: the mic dying mid-conversation looks exactly like the user having gone quiet.
   */
  function watch(
    role: string,
    proc: Bun.Subprocess<never, never, "pipe">,
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
   * Play by writing to sox's stdin, one process per reply.
   *
   * The obvious shape — one long-lived sox reading a FIFO — is what this replaces, and it was wrong
   * in three ways that all sounded like different bugs. Its input buffer had to be tiny (1024 bytes,
   * 21ms) so that playback would keep pace with the controller's estimate of it; that left sox with
   * 21ms of read-ahead, so every gap between the 200ms bursts arriving off the socket starved the
   * output device, and dozens of dropouts a second is not speech, it is a growl. Writes went into a
   * 64KB pipe, so a reply longer than that applied backpressure to the socket. And because a FIFO
   * needs a reader held open to avoid EOF, *we* held one — which meant a speaker that died left our
   * writes blocking on a pipe nobody would ever read again, and the Summons went mute reporting
   * nothing.
   *
   * Writing to stdin fixes all three at once. Bun's FileSink buffers in user space, so a whole reply
   * is accepted immediately and sox is fed as fast as it can read: it cannot starve, and the socket
   * is never made to wait. Closing stdin at the end of a reply makes sox drain what it has and exit,
   * which is also what finally plays the last syllable of a sentence instead of holding it back.
   */
  function ensureSpeaker(): Bun.Subprocess<"pipe", "ignore", "pipe"> {
    if (speaker) return speaker;
    const proc = Bun.spawn([sox, "-q", ...RAW_PCM_ARGS, "-", "-d"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    speaker = proc;
    alive.add(proc);
    void proc.exited.then(() => alive.delete(proc));
    opts.onDebug?.("speaker: ready");
    // Exiting once its stdin is closed is the design, not a failure — so a speaker that is no
    // longer the current one is retired, and its exit is expected.
    watch(
      "speaker",
      proc as unknown as Bun.Subprocess<never, never, "pipe">,
      () => speaker !== proc,
    );
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
      recorder = Bun.spawn([sox, "-q", "-d", ...RAW_PCM_ARGS, "-"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      opts.onDebug?.("mic: recorder started");
      watch("microphone", recorder as unknown as Bun.Subprocess<never, never, "pipe">);
      pump = drainMic(recorder.stdout, onChunk).catch((err: unknown) => {
        if (!stopping) opts.onFailure?.(`the microphone stream failed: ${String(err)}`);
      });
      // Warmed here rather than on the first delta: spawning sox takes a couple of hundred
      // milliseconds, and the controller starts its half-duplex clock the moment audio arrives, so a
      // speaker spawned late means real playback runs behind the controller's estimate of it.
      ensureSpeaker();
      return Promise.resolve();
    },

    play(pcm) {
      // Never awaited: the FileSink takes the whole reply into user space, so this cannot block the
      // socket that is still receiving it.
      void ensureSpeaker().stdin.write(Buffer.from(pcm, "base64"));
    },

    endReply() {
      release("drain");
      // Replaced immediately so the next reply does not pay for a spawn.
      ensureSpeaker();
    },

    flush() {
      release("cut");
      ensureSpeaker();
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
