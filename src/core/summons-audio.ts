import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * How much of the FIFO sox swallows before it plays any of it. The default is 8192 bytes — at this
 * sample rate, 170 ms of speech held back waiting for a buffer that only fills when the *next*
 * reply arrives, seconds later. That is heard as the end of every sentence being clipped off.
 *
 * It also breaks the half-duplex mic gate, which reopens the mic on how long the reply *should*
 * have taken to play: audio still coming out of the speakers after that estimate gets heard,
 * trips the model's voice detection, and makes it interrupt itself mid-sentence. Reading the FIFO
 * in small bites keeps real playback within a frame or two of the estimate, so both stop.
 */
const SPEAKER_INPUT_BUFFER_BYTES = 1024;

export interface SoxAudioOptions {
  /** Called when a `sox` process dies on its own — the session is deaf or mute from then on. */
  onFailure?: ((message: string) => void) | undefined;
  onDebug?: ((message: string) => void) | undefined;
}

export function createSoxAudio(opts: SoxAudioOptions = {}): AudioPort {
  const sox = requireAudioTool((command) => Bun.which(command));
  let recorder: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let speaker: Bun.Subprocess<"ignore", "ignore", "pipe"> | null = null;
  let pump: Promise<void> | null = null;
  let stopping = false;

  /**
   * Each speaker gets its own FIFO. A flush abandons the pipe rather than draining it, and a fresh
   * path means the replacement cannot inherit anything still sitting in the old one.
   */
  const fifoPathFor = (gen: number) => join(tmpdir(), `servant-summons-${process.pid}-${gen}.pcm`);
  let generation = 0;
  let fifo: Awaited<ReturnType<typeof open>> | null = null;
  let speakerReady: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();

  /**
   * Watch a `sox` we did not kill ourselves. Silence here is what makes this layer's failures
   * invisible: the mic dying mid-conversation looks exactly like the user having gone quiet.
   *
   * `retired` is how a speaker killed by a flush is told apart from one that died: without it the
   * first barge-in would report the speaker as having failed and hang the whole Summons up.
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
   * Play through a FIFO rather than sox's stdin. Feeding sox from a pipe looks like it should work
   * and does — until the pipe drains, at which point sox decides the stream ended and exits 0. A
   * reply always arrives faster than it plays and the gaps between replies are seconds long, so
   * that killed the speaker the first time the agent spoke. A FIFO opened O_RDWR never reports EOF
   * (we hold a reader ourselves) and never blocks on open, so silence is just an empty pipe.
   */
  async function startSpeaker(): Promise<void> {
    const gen = generation;
    const fifoPath = fifoPathFor(gen);
    await rm(fifoPath, { force: true });
    const made = Bun.spawn(["mkfifo", fifoPath], { stderr: "pipe" });
    if ((await made.exited) !== 0) {
      throw new Error((await new Response(made.stderr).text()).trim() || "mkfifo failed");
    }
    const handle = await open(fifoPath, "r+");
    const proc = Bun.spawn(
      [
        sox,
        "-q",
        "--input-buffer",
        String(SPEAKER_INPUT_BUFFER_BYTES),
        ...RAW_PCM_ARGS,
        fifoPath,
        "-d",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    // A flush that lands while this was still starting up has already moved the generation on, so
    // the pipe it was building belongs to nobody: close it rather than installing it.
    if (gen !== generation) {
      proc.kill();
      await handle.close().catch(() => {});
      await rm(fifoPath, { force: true });
      return;
    }
    fifo = handle;
    speaker = proc;
    opts.onDebug?.("speaker: playback started");
    watch(
      "speaker",
      proc as unknown as Bun.Subprocess<never, never, "pipe">,
      () => gen !== generation,
    );
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
      // Started here rather than on the first delta, which is the whole point. Spawning sox takes a
      // couple of hundred milliseconds, and the controller starts its half-duplex clock the moment
      // the audio arrives — so a lazy speaker means real playback runs that far behind the
      // controller's estimate of it, the mic reopens while the reply is still coming out, and the
      // agent interrupts itself on its own first sentence. Silence costs nothing: it is an empty pipe.
      speakerReady ??= startSpeaker();
      return Promise.resolve();
    },

    play(pcm) {
      const gen = generation;
      speakerReady ??= startSpeaker();
      const bytes = Buffer.from(pcm, "base64");
      // Serialized and never awaited here: a reply longer than the pipe buffer applies real
      // backpressure, and blocking on it would stall the socket that is still receiving it.
      writes = writes
        .then(() => speakerReady)
        // A write queued before a flush must not land in the pipe that replaced it, or the audio
        // the user interrupted comes back out after the interruption.
        .then(() => (gen === generation ? fifo?.write(bytes) : undefined))
        .catch((err: unknown) => {
          if (!stopping) opts.onFailure?.(`playback failed: ${String(err)}`);
        });
    },

    flush() {
      const dead = { speaker, fifo, path: fifoPathFor(generation) };
      generation += 1;
      speaker = null;
      fifo = null;
      writes = Promise.resolve();
      dead.speaker?.kill();
      void (async () => {
        await dead.fifo?.close().catch(() => {});
        await rm(dead.path, { force: true });
      })();
      // Replaced straight away rather than lazily: the reply to the interruption is a few hundred
      // milliseconds behind it, and spawning sox inside that gap reintroduces exactly the latency
      // the eager start above exists to remove.
      speakerReady = startSpeaker();
      opts.onDebug?.("speaker: queued playback flushed");
    },

    async stop() {
      stopping = true;
      recorder?.kill();
      recorder = null;
      await pump;
      pump = null;
      await writes.catch(() => {});
      // Awaited before the kill, not after: a speaker still spawning would otherwise install itself
      // once we had already killed its predecessor, and outlive the Summons playing to nobody.
      await speakerReady?.catch(() => {});
      speaker?.kill();
      speaker = null;
      await fifo?.close().catch(() => {});
      fifo = null;
      speakerReady = null;
      await rm(fifoPathFor(generation), { force: true });
    },
  };
}
