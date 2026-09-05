import { tmpdir } from "node:os";
import { join } from "node:path";

// The audible half's one network hop: Ear-copy in, PCM out. Kept behind the `SpeechModel` port so
// every test in this feature runs offline, and so `say` can stand in for the endpoint without the
// Player knowing which one it got (workspace ADR 0001).

/**
 * 24 kHz mono little-endian signed 16-bit — what `/v1/audio/speech` returns for `response_format:
 * "pcm"`, and what `sox` is told to expect. Everything downstream measures time in bytes of this,
 * which is why it is exact arithmetic and not a guess: 48 bytes is a millisecond, always.
 */
export const NARRATION_SAMPLE_RATE = 24_000;
export const NARRATION_BYTES_PER_MS = (NARRATION_SAMPLE_RATE * 2) / 1000;

/** Bytes of PCM as milliseconds of speech. */
export function bytesToMs(bytes: number): number {
  return bytes / NARRATION_BYTES_PER_MS;
}

/**
 * Milliseconds as bytes, floored onto a sample boundary. An offset landing inside a sample would
 * hand `sox` a byte-swapped stream — a burst of noise at every seek, which is worse than the ±20µs.
 */
export function msToBytes(ms: number): number {
  const bytes = Math.round(ms * NARRATION_BYTES_PER_MS);
  return bytes - (bytes % 2);
}

/**
 * One voice. `engine` and `voice` are what the cache keys on alongside the Ear-copy, so anything
 * that changes how a given sentence sounds has to change one of these two strings — otherwise a
 * tuned voice is served yesterday's audio and the tuning looks like it did nothing.
 */
export interface SpeechModel {
  readonly engine: string;
  readonly voice: string;
  /** PCM for one piece of Ear-copy, in order. Streamed, because the first word is the budget. */
  speak(text: string): AsyncIterable<Uint8Array>;
}

const SPEECH_URL = "https://api.openai.com/v1/audio/speech";

/** Measured on this machine: PCM TTFB 0.68–1.90s, 3.5–5.0s in total for ~20s of speech. */
export const DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_NARRATION_VOICE = "alloy";

/**
 * How the words are delivered, which `gpt-4o-mini-tts` takes as a separate instruction from the
 * text. It says "narrator", because the model's default register is customer-service bright and a
 * Narration is somebody reading you your own screen.
 */
export const NARRATION_STYLE =
  "Read this as a colleague narrating what is on screen: even, unhurried, matter-of-fact. " +
  "No brightness, no salesmanship, no rising question intonation on statements.";

export interface OpenAiSpeechOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  /** Overriding it changes how everything sounds, so it changes `engine` and misses the cache. */
  style?: string;
  fetch?: typeof fetch;
}

export function createOpenAiSpeechModel(options: OpenAiSpeechOptions): SpeechModel {
  const call = options.fetch ?? fetch;
  const model = options.model ?? DEFAULT_SPEECH_MODEL;
  const voice = options.voice ?? DEFAULT_NARRATION_VOICE;
  const style = options.style ?? NARRATION_STYLE;
  return {
    // The style is part of the engine because it is part of the sound. Folded to a short digest
    // rather than carried whole: this string ends up in a filename.
    engine: style === NARRATION_STYLE ? model : `${model}+${shortDigest(style)}`,
    voice,
    async *speak(text) {
      const response = await call(SPEECH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          instructions: style,
          response_format: "pcm",
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Synthesis failed: ${response.status} ${await response.text()}`);
      }
      for await (const chunk of response.body) yield chunk;
    },
  };
}

function shortDigest(text: string): string {
  return Bun.hash(text).toString(16).slice(0, 8);
}

/** A `say` subprocess writing one WAV. Injected by the suite; the default spawns the real thing. */
export interface SayProcess {
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
}

export interface SayOptions {
  /** A macOS voice name. Empty means the system default, which is what most people have set. */
  voice?: string;
  spawn?: (args: string[], outPath: string) => SayProcess;
}

/**
 * The offline engine, and the reason the pipeline was worth building: with rewriting separated from
 * speaking, "no network" costs the voice and nothing else.
 *
 * Chosen up front for a whole Narration, never mid-stream. Swapping voices between Segment four and
 * five would sound like a fault, and the listener has no way to know it was the network.
 */
export function createSaySpeechModel(options: SayOptions = {}): SpeechModel {
  const voice = options.voice ?? "";
  const spawn = options.spawn ?? spawnSay;
  return {
    engine: "say",
    voice,
    async *speak(text) {
      const outPath = tempWavPath();
      const args = [
        ...(voice ? ["-v", voice] : []),
        "--data-format=LEI16@24000",
        "--file-format=WAVE",
        "-o",
        outPath,
        text,
      ];
      const proc = spawn(args, outPath);
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0) {
        throw new Error(`say failed: ${stderr.trim() || `exit code ${code}`}`);
      }
      try {
        yield pcmFromWav(new Uint8Array(await Bun.file(outPath).arrayBuffer()));
      } finally {
        await Bun.file(outPath)
          .delete()
          .catch(() => {});
      }
    },
  };
}

function tempWavPath(): string {
  return join(tmpdir(), `servant-narrate-${crypto.randomUUID()}.wav`);
}

function spawnSay(args: string[], _outPath: string): SayProcess {
  const say = Bun.which("say");
  if (!say) throw new Error("`say` is not on PATH — offline narration needs it (macOS only).");
  return Bun.spawn([say, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  }) as unknown as SayProcess;
}

/**
 * The `data` chunk of a RIFF/WAVE file, by walking the chunk list.
 *
 * Not "skip 44 bytes": `say` writes an `FLLR` padding chunk between `fmt ` and `data`, so the fixed
 * offset every example uses lands four kilobytes early — a burst of zeroes and then audio, which
 * sounds like a broken device rather than a broken parser.
 */
export function pcmFromWav(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAVE file.");
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") assertNarrationFormat(view, body);
    if (id === "data") return bytes.subarray(body, Math.min(body + size, bytes.byteLength));
    // Chunks are word-aligned, and an odd-sized one is followed by a pad byte that is not counted.
    at = body + size + (size % 2);
  }
  throw new Error("WAVE file has no data chunk.");
}

function assertNarrationFormat(view: DataView, at: number): void {
  const channels = view.getUint16(at + 2, true);
  const rate = view.getUint32(at + 4, true);
  const bits = view.getUint16(at + 14, true);
  if (channels !== 1 || rate !== NARRATION_SAMPLE_RATE || bits !== 16) {
    throw new Error(
      `Expected 1×${NARRATION_SAMPLE_RATE}×16 PCM, got ${channels}×${rate}×${bits} — the timeline's byte arithmetic would be wrong.`,
    );
  }
}
