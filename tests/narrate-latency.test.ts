// The one measurement that cannot be faked, and the only test here that touches the network.
//
// Skipped unless `SERVANT_NARRATE_BENCH=1`, so it never runs in CI and never runs by accident: it
// spends real money on two OpenAI endpoints, and a latency number measured against a fake is a
// number about the fake. The ticket budgets time to first word at ≤2s cold and no gap over 200ms
// between Segments, and both are claims about the real thing.
//
//   SERVANT_NARRATE_BENCH=1 bun test tests/narrate-latency.test.ts
//
// It needs OPENAI_API_KEY (environment or the servant root's .env) and at least one Claude
// transcript for some directory. It plays nothing: the speaker port is replaced by a stopwatch, so
// the machine stays silent and the numbers are about the pipeline rather than about the device.

import { describe, expect, test } from "bun:test";
import type { NarrationSpeaker } from "../src/core/narrate-audio.ts";
import { createOpenAiEarCopyModel } from "../src/core/narrate-model.ts";
import { createNarrationPlayer } from "../src/core/narrate-player.ts";
import { narrateTurnStream } from "../src/core/narrate-session.ts";
import { type Turn, readTurns } from "../src/core/narrate-turn.ts";
import { createOpenAiSpeechModel } from "../src/core/narrate-voice.ts";
import { readServantEnv, resolveSecret } from "../src/core/servant-env.ts";
import { claudeProjectsRoot } from "../src/core/claude-session.ts";

const ENABLED = process.env.SERVANT_NARRATE_BENCH === "1";

/** The ticket's two numbers. */
const FIRST_WORD_BUDGET_MS = 2000;
const GAP_BUDGET_MS = 200;

/** A speaker that measures instead of playing: same seam, no device, no noise. */
function stopwatch(since: () => number) {
  const gaps: number[] = [];
  let firstWrite: number | null = null;
  let lastRunEnded: number | null = null;
  const speaker: NarrationSpeaker = {
    open() {
      if (lastRunEnded !== null) gaps.push(since() - lastRunEnded);
      return {
        write() {
          firstWrite ??= since();
        },
        async finish() {
          lastRunEnded = since();
        },
        kill() {
          lastRunEnded = since();
        },
        exited: Promise.resolve(0),
      };
    },
  };
  return {
    speaker,
    gaps,
    get firstWrite() {
      return firstWrite;
    },
  };
}

/**
 * Any complete Turn long enough to be worth narrating, off any transcript on this machine. Not a
 * fixture: the point of this file is that it measures the real shapes a real session produces.
 */
async function someRealTurn(): Promise<{ path: string; turn: Turn } | null> {
  const glob = new Bun.Glob("*/*.jsonl");
  for await (const relative of glob.scan({ cwd: claudeProjectsRoot(), onlyFiles: true })) {
    const path = `${claudeProjectsRoot()}/${relative}`;
    const turn = (await readTurns(path)).find(
      (candidate) => candidate.complete && candidate.markdown.length > 200,
    );
    if (turn) return { path, turn };
  }
  return null;
}

describe.skipIf(!ENABLED)("latency, over the real APIs", () => {
  test(
    "the first word is spoken inside the budget, and no Segment leaves a gap",
    async () => {
      const key = resolveSecret("OPENAI_API_KEY", process.env, await readServantEnv());
      expect(key, "OPENAI_API_KEY is needed to measure anything real").toBeTruthy();
      const found = await someRealTurn();
      expect(found, "no Claude transcript on this machine to narrate").not.toBeNull();
      if (!key || !found) return;

      const started = Bun.nanoseconds();
      const since = () => Math.round((Bun.nanoseconds() - started) / 1e6);
      const watch = stopwatch(since);

      // The first word is the sum of two network hops, and when it is late it is late because one
      // of them was. Splitting them here is what makes a missed budget a fact about the endpoints
      // rather than a mystery about the Player.
      let firstSentence: number | null = null;
      const timed = async function* () {
        for await (const event of narrateTurnStream(found.path, found.turn, {
          model: createOpenAiEarCopyModel({ apiKey: key }),
        })) {
          if (event.type === "sentence") firstSentence ??= since();
          yield event;
        }
      };

      const player = createNarrationPlayer({
        events: timed(),
        speech: createOpenAiSpeechModel({ apiKey: key }),
        speaker: watch.speaker,
      });

      // Long enough to hear several Segments go by, which is what the gap budget is about. The
      // Narration does not have to reach its end for that.
      while (watch.gaps.length < 3 && since() < 60_000 && !player.state().finished) {
        await Bun.sleep(50);
      }
      await player.stop();

      console.log(
        `narrate: first word at ${watch.firstWrite}ms ` +
          `(rewrite ${firstSentence}ms, then speech + cushion ${(watch.firstWrite ?? 0) - (firstSentence ?? 0)}ms); ` +
          `gaps ${watch.gaps.join(", ") || "none"}`,
      );
      expect(watch.firstWrite).not.toBeNull();
      expect(watch.firstWrite ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
        FIRST_WORD_BUDGET_MS,
      );
      expect(Math.max(0, ...watch.gaps)).toBeLessThanOrEqual(GAP_BUDGET_MS);
    },
    { timeout: 90_000 },
  );
});
