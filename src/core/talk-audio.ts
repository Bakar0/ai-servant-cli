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

export function createSoxAudio(): AudioPort {
  const sox = requireAudioTool((command) => Bun.which(command));
  let recorder: Bun.Subprocess<"ignore", "pipe", "ignore"> | null = null;
  let speaker: Bun.Subprocess<"pipe", "ignore", "ignore"> | null = null;
  let pump: Promise<void> | null = null;

  function speakerStdin() {
    // `-` reads raw PCM from stdin, `-d` plays to the default output device.
    speaker ??= Bun.spawn([sox, "-q", ...RAW_PCM_ARGS, "-", "-d"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    return speaker.stdin;
  }

  /** Re-chunk sox's arbitrary-sized reads into the frame size the API wants. */
  async function drainMic(stdout: ReadableStream<Uint8Array>, onChunk: (pcm: string) => void) {
    let pending = new Uint8Array(0);
    for await (const chunk of stdout) {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      let offset = 0;
      while (merged.length - offset >= CHUNK_BYTES) {
        onChunk(Buffer.from(merged.subarray(offset, offset + CHUNK_BYTES)).toString("base64"));
        offset += CHUNK_BYTES;
      }
      pending = merged.slice(offset);
    }
  }

  return {
    startCapture(onChunk) {
      // `-d` records from the default input device. The mic stays open for the life of the session
      // — nothing is gated on a keypress, so the keyboard is never captured.
      recorder = Bun.spawn([sox, "-q", "-d", ...RAW_PCM_ARGS, "-"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      pump = drainMic(recorder.stdout, onChunk).catch(() => {
        // The recorder was killed by stop(); a half-read frame is nothing to report.
      });
      return Promise.resolve();
    },

    play(pcm) {
      const stdin = speakerStdin();
      void stdin.write(Buffer.from(pcm, "base64"));
      void stdin.flush();
    },

    async stop() {
      recorder?.kill();
      speaker?.kill();
      recorder = null;
      speaker = null;
      await pump;
      pump = null;
    },
  };
}
