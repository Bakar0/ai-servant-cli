import { requireAudioTool } from "./talk-preflight.ts";
import type { AudioPort } from "./talk.ts";

// Microphone and speaker for a Talk session, built on two long-lived `sox` subprocesses. Chosen
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
  let pump: Promise<void> | null = null;
  let stopping = false;

  /**
   * Watch a `sox` we did not kill ourselves. Silence here is what makes this layer's failures
   * invisible: the mic dying mid-conversation looks exactly like the user having gone quiet.
   */
  function watch(role: string, proc: Bun.Subprocess<never, never, "pipe">): void {
    void (async () => {
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (stopping) return;
      const detail = stderr.trim() || `exit code ${code}`;
      opts.onFailure?.(`the ${role} (sox) stopped: ${detail}`);
    })();
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
      return Promise.resolve();
    },

    play(pcm) {
      if (!speaker) {
        // `-` reads raw PCM from stdin, `-d` plays to the default output device.
        speaker = Bun.spawn([sox, "-q", ...RAW_PCM_ARGS, "-", "-d"], {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "pipe",
        });
        opts.onDebug?.("speaker: playback started");
        watch("speaker", speaker as unknown as Bun.Subprocess<never, never, "pipe">);
      }
      void speaker.stdin.write(Buffer.from(pcm, "base64"));
      void speaker.stdin.flush();
    },

    async stop() {
      stopping = true;
      recorder?.kill();
      speaker?.kill();
      recorder = null;
      speaker = null;
      await pump;
      pump = null;
    },
  };
}
