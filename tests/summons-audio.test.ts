import { describe, expect, test } from "bun:test";
import {
  createSoxAudio,
  type AudioProcesses,
  type RecorderProcess,
  type SpeakerProcess,
} from "../src/core/summons-audio.ts";

// What this file guards is not sound — it is everything the audio port decides *around* the sound,
// which is where the growl, the swallowed last syllable and the Summons that would not exit all
// came from. Each of those was found live and fixed once; a fake `sox` is what keeps them fixed.

const SAMPLE_RATE = 24_000;
/** 600ms — the cushion the device must open with, in bytes of 16-bit mono PCM. */
const PRIME_BYTES = (SAMPLE_RATE / 1000) * 600 * 2;
/** 200ms — the frame size the Realtime API wants off the mic. */
const CHUNK_BYTES = (SAMPLE_RATE / 5) * 2;

/** `ms` of (silent, but that is not the point) PCM, base64 as the port takes it. */
function audio(ms: number): string {
  return Buffer.alloc((SAMPLE_RATE / 1000) * ms * 2).toString("base64");
}

function bytesOf(ms: number): number {
  return (SAMPLE_RATE / 1000) * ms * 2;
}

interface FakeSpeaker extends SpeakerProcess {
  readonly args: string[];
  readonly writes: Uint8Array[];
  /** Total bytes handed to `sox`, which is the only measure of "enough to open the device with". */
  readonly written: () => number;
  ended: boolean;
  killed: boolean;
  die(code: number, text?: string): void;
}

interface FakeRecorder extends RecorderProcess {
  readonly args: string[];
  killed: boolean;
  push(bytes: number): void;
  endInput(): void;
  die(code: number, text?: string): void;
}

/** A stream a test fills and closes by hand, standing in for a subprocess's stderr. */
function textStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let closed = false;
  return {
    stream,
    finish(text: string) {
      if (closed) return;
      closed = true;
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  };
}

function fakeProcesses() {
  const speakers: FakeSpeaker[] = [];
  const recorders: FakeRecorder[] = [];

  const processes: AudioProcesses = {
    speaker(args) {
      let exit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        exit = resolve;
      });
      const stderr = textStream();
      const writes: Uint8Array[] = [];
      const speaker: FakeSpeaker = {
        args,
        writes,
        written: () => writes.reduce((total, chunk) => total + chunk.length, 0),
        ended: false,
        killed: false,
        stdin: {
          write: (chunk) => void writes.push(chunk),
          end: () => {
            speaker.ended = true;
          },
        },
        stderr: stderr.stream,
        exited,
        kill: () => {
          speaker.killed = true;
          speaker.die(1);
        },
        die: (code, text = "") => {
          // A dying subprocess closes its pipes, which is what lets the watcher read stderr at all.
          stderr.finish(text);
          exit(code);
        },
      };
      speakers.push(speaker);
      return speaker;
    },

    recorder(args) {
      let exit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        exit = resolve;
      });
      const stderr = textStream();
      let push!: (bytes: number) => void;
      let closeStdout!: () => void;
      let stdoutOpen = true;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (bytes) => controller.enqueue(new Uint8Array(bytes));
          closeStdout = () => {
            if (!stdoutOpen) return;
            stdoutOpen = false;
            controller.close();
          };
        },
      });
      const recorder: FakeRecorder = {
        args,
        killed: false,
        stdout,
        stderr: stderr.stream,
        exited,
        kill: () => {
          recorder.killed = true;
          recorder.die(1);
        },
        push: (bytes) => push(bytes),
        endInput: () => closeStdout(),
        die: (code, text = "") => {
          // Killing sox ends the PCM as well — without this the mic pump would never finish, and
          // `stop()` awaits it.
          closeStdout();
          stderr.finish(text);
          exit(code);
        },
      };
      recorders.push(recorder);
      return recorder;
    },
  };

  return { processes, speakers, recorders };
}

function createAudio(onFailure?: (message: string) => void, onLost?: (message: string) => void) {
  const fake = fakeProcesses();
  const audioPort = createSoxAudio({
    processes: fake.processes,
    ...(onFailure ? { onFailure } : {}),
    ...(onLost ? { onLost } : {}),
  });
  return { ...fake, audio: audioPort };
}

/** A port whose two failure channels are collected apart, since which one fires is the point. */
function createWatchedAudio() {
  const failures: string[] = [];
  const lost: string[] = [];
  return {
    failures,
    lost,
    ...createAudio(
      (message) => failures.push(message),
      (message) => lost.push(message),
    ),
  };
}

/** Let the microbtask queue drain, which is all any of the port's own promises need. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("opening the device", () => {
  test("nothing is spawned until there is a cushion to open with", () => {
    const { audio: port, speakers } = createAudio();

    port.play(audio(200));
    port.play(audio(300));

    // 500ms in hand and no speaker yet: a sox opened now would starve, and a starved device growls.
    expect(speakers).toHaveLength(0);
  });

  test("the device opens with the whole cushion already behind it", () => {
    const { audio: port, speakers } = createAudio();

    port.play(audio(200));
    port.play(audio(300));
    port.play(audio(200));

    expect(speakers).toHaveLength(1);
    // Not "the last delta" — everything gathered, written before sox can read a byte.
    expect(speakers[0]?.writes[0]?.length).toBe(bytesOf(700));
    expect(speakers[0]?.written()).toBeGreaterThanOrEqual(PRIME_BYTES);
  });

  test("a reply gets one speaker, not one per delta", () => {
    const { audio: port, speakers } = createAudio();

    port.play(audio(700));
    for (let delta = 0; delta < 20; delta++) port.play(audio(200));

    expect(speakers).toHaveLength(1);
    expect(speakers[0]?.written()).toBe(bytesOf(700 + 20 * 200));
  });

  test("sox is asked for the wire format, on the default device", () => {
    const { audio: port, speakers } = createAudio();

    port.play(audio(700));

    const args = speakers[0]?.args ?? [];
    expect(args.join(" ")).toContain("-r 24000");
    expect(args.join(" ")).toContain("-c 1");
    expect(args.join(" ")).toContain("-b 16");
    // Reads PCM from stdin, plays to the default output — never a FIFO, which is what starved it.
    expect(args.slice(-2)).toEqual(["-", "-d"]);
    // Without this, `sox` sizes a reply by what happened to be buffered when it opened — Bun hands
    // a child a socket, and `fstat` on a socket reports exactly that. It played the cushion, said
    // "Done." and exited 0 mid-sentence.
    expect(args).toContain("--ignore-length");
  });
});

describe("ending a reply", () => {
  test("stdin is closed rather than the process killed — that is what plays the last syllable", () => {
    const { audio: port, speakers } = createAudio();
    port.play(audio(700));

    port.endReply();

    expect(speakers[0]?.ended).toBe(true);
    expect(speakers[0]?.killed).toBe(false);
  });

  test("a reply shorter than the cushion is still played, not held for audio that never comes", () => {
    const { audio: port, speakers } = createAudio();
    port.play(audio(120));

    port.endReply();

    expect(speakers).toHaveLength(1);
    expect(speakers[0]?.writes[0]?.length).toBe(bytesOf(120));
    expect(speakers[0]?.ended).toBe(true);
  });

  test("the next reply opens its own speaker, with its own cushion", () => {
    const { audio: port, speakers } = createAudio();
    port.play(audio(700));
    port.endReply();

    port.play(audio(700));

    expect(speakers).toHaveLength(2);
    expect(speakers[1]?.writes[0]?.length).toBe(bytesOf(700));
  });
});

describe("being cut off", () => {
  test("a barge-in kills the speaker rather than letting it drain", () => {
    const { audio: port, speakers } = createAudio();
    port.play(audio(700));

    port.flush();

    expect(speakers[0]?.killed).toBe(true);
  });

  test("audio held back for a cushion is dropped, not leaked into the next reply", () => {
    const { audio: port, speakers } = createAudio();
    // Interrupted before there was ever enough to open the device with.
    port.play(audio(300));

    port.flush();
    port.play(audio(700));

    // 700ms, not 1000ms: the interrupted reply's head went nowhere, which is what makes a barge-in
    // feel like an interruption rather than a pause.
    expect(speakers).toHaveLength(1);
    expect(speakers[0]?.writes[0]?.length).toBe(bytesOf(700));
  });
});

describe("hanging up", () => {
  test("every speaker is ended and reaped, including one still draining a finished reply", async () => {
    const { audio: port, speakers, recorders } = createAudio();
    await port.startCapture(() => {});
    port.play(audio(700));
    port.endReply(); // left draining — still a live child
    port.play(audio(700)); // and a second one, mid-reply

    await port.stop();

    // An unreaped child and an open stdin both keep the process alive, and a Summons that cannot
    // hang up is worse than a silent one.
    expect(speakers).toHaveLength(2);
    for (const speaker of speakers) {
      expect(speaker.ended).toBe(true);
      expect(speaker.killed).toBe(true);
    }
    expect(recorders[0]?.killed).toBe(true);
  });

  test("stop() waits for the children it killed", async () => {
    const { audio: port } = createAudio();
    port.play(audio(700));

    // Resolves at all: `stop()` awaits every `exited`, so a fake that never exits would hang here.
    await expect(port.stop()).resolves.toBeUndefined();
  });
});

describe("the microphone", () => {
  test("sox's arbitrary reads are re-chunked into the frame size the API wants", async () => {
    const { audio: port, recorders } = createAudio();
    const frames: string[] = [];
    await port.startCapture((pcm) => frames.push(pcm));

    recorders[0]?.push(CHUNK_BYTES * 2 + 1_000);
    await settle();

    expect(frames).toHaveLength(2);
    expect(Buffer.from(frames[0] ?? "", "base64").length).toBe(CHUNK_BYTES);
  });

  test("a partial frame is held until the rest of it arrives, never sent short", async () => {
    const { audio: port, recorders } = createAudio();
    const frames: string[] = [];
    await port.startCapture((pcm) => frames.push(pcm));

    recorders[0]?.push(CHUNK_BYTES - 100);
    await settle();
    expect(frames).toHaveLength(0);

    recorders[0]?.push(100);
    await settle();
    expect(frames).toHaveLength(1);
  });
});

describe("a sox that dies on its own", () => {
  test("a dead microphone is reported — it looks exactly like the user having gone quiet", async () => {
    const failures: string[] = [];
    const { audio: port, recorders } = createAudio((message) => failures.push(message));
    await port.startCapture(() => {});

    recorders[0]?.die(1, "sox: cannot open audio device");
    await settle();

    expect(failures[0]).toContain("microphone");
    expect(failures[0]).toContain("cannot open audio device");
  });

  test("a speaker exiting after its reply is the design, not a failure", async () => {
    const failures: string[] = [];
    const { audio: port, speakers } = createAudio((message) => failures.push(message));
    port.play(audio(700));
    port.endReply();

    // Exactly what a healthy speaker does once its stdin is closed: drain, then exit.
    speakers[0]?.die(0);
    await settle();

    expect(failures).toEqual([]);
  });

  test("a speaker dying mid-reply loses the reply, not the conversation", async () => {
    const { audio: port, speakers, failures, lost } = createWatchedAudio();
    port.play(audio(700));

    // What macOS moving the default output out from under `sox` looks like: a clean exit, no
    // stderr, in the middle of a sentence. Hanging up on it played about a word and ended the call.
    speakers[0]?.die(0);
    await settle();

    expect(failures).toEqual([]);
    expect(lost[0]).toContain("stopped mid-reply");
  });

  test("the rest of the reply is played, on a speaker of its own", async () => {
    const { audio: port, speakers } = createWatchedAudio();
    port.play(audio(700));
    speakers[0]?.die(0);
    await settle();

    port.play(audio(700));

    expect(speakers).toHaveLength(2);
    expect(speakers[1]?.writes[0]?.length).toBe(bytesOf(700));
  });

  test("a device that cannot be played to at all is a failure, not an endless supply of sox", async () => {
    const { audio: port, speakers, failures, lost } = createWatchedAudio();

    for (let attempt = 0; attempt < 3; attempt++) {
      port.play(audio(700));
      speakers[attempt]?.die(0);
      await settle();
    }

    expect(lost).toHaveLength(2);
    expect(failures[0]).toContain("3 times in a row");
    // The third death is the last: nothing else is spawned on its account.
    expect(speakers).toHaveLength(3);
  });

  test("a reply played to its end forgives the speakers lost before it", async () => {
    const { audio: port, speakers, failures } = createWatchedAudio();
    port.play(audio(700));
    speakers[0]?.die(0);
    await settle();
    port.play(audio(700));
    speakers[1]?.die(0);
    await settle();

    // A whole reply out of the speakers — whatever the device was doing, it is over.
    port.play(audio(700));
    port.endReply();
    await settle();

    port.play(audio(700));
    speakers[3]?.die(0);
    await settle();

    expect(failures).toEqual([]);
  });

  test("nothing is reported once the Summons is hanging up — the children die because we killed them", async () => {
    const failures: string[] = [];
    const { audio: port } = createAudio((message) => failures.push(message));
    await port.startCapture(() => {});
    port.play(audio(700));

    await port.stop();
    await settle();

    expect(failures).toEqual([]);
  });
});

// The live bug: type at a Summons while it is still speaking and two replies came out of the
// speakers at once. `endReply` retires a finished reply to *drain* — it stops being the current
// speaker and keeps playing, which is what plays the last syllable — and both the flush and the
// next reply's speaker only ever knew about the current one.
describe("only one reply is ever audible", () => {
  test("flushing silences a reply left draining, not just the one being generated", () => {
    const { audio: port, speakers } = createAudio();
    port.play(audio(700));
    port.endReply();
    expect(speakers).toHaveLength(1);
    expect(speakers[0]?.killed).toBe(false);

    port.flush();

    expect(speakers[0]?.killed).toBe(true);
  });

  test("a new reply silences the last one before opening its own device", () => {
    const { audio: port, speakers } = createAudio();
    port.play(audio(700));
    port.endReply();

    // No interruption at all — the next reply simply begins while the previous one is still playing,
    // which is what an announcement fired at `reply_done` does.
    port.play(audio(700));

    expect(speakers).toHaveLength(2);
    expect(speakers[0]?.killed).toBe(true);
    expect(speakers[1]?.killed).toBe(false);
  });

  test("an ordinary reply is still drained rather than cut, so its last syllable plays", () => {
    const { audio: port, speakers } = createAudio();
    port.play(audio(700));

    port.endReply();

    expect(speakers[0]?.killed).toBe(false);
    expect(speakers[0]?.ended).toBe(true);
  });

  test("flushing an empty speaker path is harmless", () => {
    const { audio: port, speakers } = createAudio();

    expect(() => port.flush()).not.toThrow();
    expect(speakers).toHaveLength(0);
  });
});
