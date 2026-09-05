// What is handed to `sox` and when. How it sounds coming out of the device can only be checked by
// ear; everything that is a *decision* about playback is a claim about this argument list and about
// whether a run is ended or killed, and both are checkable without a sound card.

import { describe, expect, test } from "bun:test";
import type { PlaybackProcess, PlaybackProcesses } from "../src/core/narrate-audio.ts";
import { createSoxSpeaker } from "../src/core/narrate-audio.ts";

function fakeProcesses(exitCode = 0, stderr = "") {
  const calls: string[][] = [];
  let ended = false;
  let killed = false;
  const written: Uint8Array[] = [];
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const processes: PlaybackProcesses = {
    play(args) {
      calls.push(args);
      const proc: PlaybackProcess = {
        stdin: {
          write: (chunk) => written.push(chunk),
          end: () => {
            ended = true;
            resolveExit(exitCode);
          },
        },
        stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
        exited,
        kill: () => {
          killed = true;
          resolveExit(exitCode);
        },
      };
      return proc;
    },
  };
  return {
    processes,
    calls,
    written,
    /** The device going away under a run: neither ended nor killed by us. */
    die: () => resolveExit(exitCode),
    get ended() {
      return ended;
    },
    get killed() {
      return killed;
    },
  };
}

describe("what sox is told", () => {
  test("the raw format, spelled out, since raw pcm has no header to read it from", () => {
    const fake = fakeProcesses();
    createSoxSpeaker({ processes: fake.processes }).open(1);
    const args = (fake.calls[0] ?? []).join(" ");
    expect(args).toContain("-t raw -b 16 -e signed-integer -r 24000 -c 1");
  });

  test("to read until the input ends rather than trusting how long it looks", () => {
    const fake = fakeProcesses();
    createSoxSpeaker({ processes: fake.processes }).open(1);
    // Bun gives a child a socket for stdin, and fstat on a socket reports what is buffered as the
    // size — without this, every run plays its first fragment and exits 0 mid-sentence.
    expect(fake.calls[0]).toContain("--ignore-length");
  });

  test("to hold very little, because everything it holds is time the position has already counted", () => {
    const fake = fakeProcesses();
    createSoxSpeaker({ processes: fake.processes }).open(1);
    const at = (fake.calls[0] ?? []).indexOf("--buffer");
    expect(at).toBeGreaterThan(-1);
    expect(Number(fake.calls[0]?.[at + 1])).toBeLessThanOrEqual(4096);
  });

  test("the tempo effect goes after the output, where sox expects its effects", () => {
    const fake = fakeProcesses();
    createSoxSpeaker({ processes: fake.processes }).open(1.4);
    const args = fake.calls[0] ?? [];
    expect(args.slice(args.indexOf("-d"))).toEqual(["-d", "tempo", "-s", "1.40"]);
  });
});

describe("ending a run", () => {
  test("finishing closes stdin, so the device drains instead of cutting off", async () => {
    const fake = fakeProcesses();
    const run = createSoxSpeaker({ processes: fake.processes }).open(1);
    run.write(new Uint8Array([1, 2]));
    await run.finish();
    expect(fake.ended).toBe(true);
    expect(fake.killed).toBe(false);
  });

  test("a Transport key kills it, because a drained buffer is the seconds you asked to skip", () => {
    const fake = fakeProcesses();
    const run = createSoxSpeaker({ processes: fake.processes }).open(1);
    run.kill();
    expect(fake.killed).toBe(true);
  });

  test("writing after the run is over is dropped rather than throwing", async () => {
    const fake = fakeProcesses();
    const run = createSoxSpeaker({ processes: fake.processes }).open(1);
    await run.finish();
    run.write(new Uint8Array([9]));
    expect(fake.written).toHaveLength(0);
  });

  test("a run that dies on its own is reported in its own words, never silently", async () => {
    const fake = fakeProcesses(2, "sox FAIL: no default audio device");
    const lost: string[] = [];
    createSoxSpeaker({ processes: fake.processes, onLost: (message) => lost.push(message) }).open(
      1,
    );
    // Not ended and not killed: the device went away under it, which is the case that used to look
    // exactly like a Narration with nothing left to say.
    fake.die();
    await Bun.sleep(1);
    expect(lost[0]).toContain("no default audio device");
  });

  test("a run ended on purpose is not reported as a death", async () => {
    const fake = fakeProcesses();
    const lost: string[] = [];
    const run = createSoxSpeaker({
      processes: fake.processes,
      onLost: (message) => lost.push(message),
    }).open(1);
    await run.finish();
    await Bun.sleep(1);
    expect(lost).toEqual([]);
  });
});
