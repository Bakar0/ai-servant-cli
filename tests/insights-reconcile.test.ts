import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InsightEvent, appendEvents } from "../src/core/insights/events.ts";
import { reconcileSession } from "../src/core/insights/reconcile.ts";
import { insightsEventLogPath, setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
let cwd: string;
let transcriptPath: string;
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-insights-reconcile-"));
  setRootOverride(tmpRoot);
  cwd = join(tmpRoot, "workspaces", "ws-alpha");
  await mkdir(cwd, { recursive: true });
  transcriptPath = join(tmpRoot, "transcript.jsonl");
});

afterEach(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** An assistant turn line carrying a usage block, with a fixed timestamp. */
function asstTurn(uuid: string, out: number, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid,
    cwd,
    timestamp: "2026-06-19T00:00:00.000Z",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 50,
        output_tokens: out,
        ...extra,
      },
    },
  };
}

// `cwd` is assigned per-test in beforeEach, so build these lazily rather than at module load.
const userLine = () => ({ type: "user", cwd, message: { role: "user", content: "ok" } });
const compactBoundaryLine = () => ({
  type: "system",
  subtype: "compact_boundary",
  uuid: "compact-1",
  cwd,
  timestamp: "2026-06-19T00:01:00.000Z",
});

async function writeTranscript(lines: unknown[]): Promise<void> {
  await writeFile(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

async function readLog(): Promise<InsightEvent[]> {
  const text = await readFile(insightsEventLogPath(SESSION), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as InsightEvent);
}

const turnIds = (log: InsightEvent[]): string[] =>
  log.filter((e) => e.event === "turn_complete").map((e) => e.turnId ?? "");

describe("reconcileSession — full reconstruction from an absent log", () => {
  test("rebuilds turns, compaction boundary, and a synthetic session_end", async () => {
    await writeTranscript([
      asstTurn("turn-1", 88),
      userLine(),
      compactBoundaryLine(),
      asstTurn("turn-2", 5),
    ]);

    const result = await reconcileSession(transcriptPath, SESSION);

    expect(result.hadLog).toBe(false);
    expect(result.byType.turn_complete).toBe(2);
    expect(result.byType.compaction_boundary).toBe(1);
    expect(result.byType.session_end).toBe(1);
    expect(result.discrepancies).toHaveLength(0);

    const log = await readLog();
    expect(turnIds(log)).toEqual(["turn-1", "turn-2"]);
    // All reconstructed events are flagged and carry the workspace from the transcript cwd.
    expect(log.every((e) => e.reconciled === true)).toBe(true);
    expect(log.every((e) => e.workspace === "ws-alpha")).toBe(true);
    // Ordered by transcript position; session_end last.
    expect(log.map((e) => e.event)).toEqual([
      "turn_complete",
      "compaction_boundary",
      "turn_complete",
      "session_end",
    ]);
    // The boundary correlates to the turn that preceded it.
    expect(log.find((e) => e.event === "compaction_boundary")?.turnId).toBe("turn-1");
  });

  test("is idempotent — a second run appends nothing", async () => {
    await writeTranscript([asstTurn("turn-1", 88), asstTurn("turn-2", 5)]);
    await reconcileSession(transcriptPath, SESSION);
    const after1 = await readLog();

    const result2 = await reconcileSession(transcriptPath, SESSION);
    expect(result2.appended).toBe(0);
    expect(await readLog()).toEqual(after1);
  });
});

describe("reconcileSession — gap fill against a partial live log", () => {
  test("appends only turns the live log is missing, never duplicating", async () => {
    // Live path captured turn-1 only (e.g. the final Stop was cancelled).
    await appendEvents(SESSION, [
      {
        v: 1,
        ts: "2026-06-19T00:00:00.000Z",
        session: SESSION,
        workspace: "ws-alpha",
        event: "turn_complete",
        turnId: "turn-1",
        ctx: null,
      },
    ]);
    await writeTranscript([asstTurn("turn-1", 88), asstTurn("turn-2", 5)]);

    const result = await reconcileSession(transcriptPath, SESSION);

    expect(result.hadLog).toBe(true);
    // turn-1 already present → not re-added; turn-2 backfilled; session_end synthesized.
    expect(result.byType.turn_complete).toBe(1);
    expect(result.byType.session_end).toBe(1);
    expect(turnIds(await readLog())).toEqual(["turn-1", "turn-2"]);
  });

  test("does not re-synthesize session_end when the log already has one", async () => {
    await appendEvents(SESSION, [
      {
        v: 1,
        ts: "2026-06-19T00:00:00.000Z",
        session: SESSION,
        workspace: "ws-alpha",
        event: "session_end",
        turnId: null,
        ctx: null,
        reason: "logout",
      },
    ]);
    await writeTranscript([asstTurn("turn-1", 88)]);

    const result = await reconcileSession(transcriptPath, SESSION);
    expect(result.byType.session_end).toBeUndefined();
    expect((await readLog()).filter((e) => e.event === "session_end")).toHaveLength(1);
  });
});

describe("reconcileSession — consistency check", () => {
  test("flags a turn whose live ctx disagrees with the transcript (incl. live-null)", async () => {
    // Live recorded turn-1 with null usage (lagging Stop); the transcript now carries the numbers.
    await appendEvents(SESSION, [
      {
        v: 1,
        ts: "2026-06-19T00:00:00.000Z",
        session: SESSION,
        workspace: "ws-alpha",
        event: "turn_complete",
        turnId: "turn-1",
        ctx: null,
      },
    ]);
    await writeTranscript([asstTurn("turn-1", 88)]);

    const result = await reconcileSession(transcriptPath, SESSION);

    // No duplicate turn_complete — the divergence is reported, not appended.
    expect(result.byType.turn_complete).toBeUndefined();
    const outputDiff = result.discrepancies.find((d) => d.field === "output");
    expect(outputDiff).toEqual({ turnId: "turn-1", field: "output", live: 0, transcript: 88 });
    const contextDiff = result.discrepancies.find((d) => d.field === "context");
    expect(contextDiff?.transcript).toBe(2150); // 100 + 2000 + 50
  });

  test("no discrepancy when live ctx matches the transcript", async () => {
    await appendEvents(SESSION, [
      {
        v: 1,
        ts: "2026-06-19T00:00:00.000Z",
        session: SESSION,
        workspace: "ws-alpha",
        event: "turn_complete",
        turnId: "turn-1",
        ctx: {
          input: 100,
          cacheRead: 2000,
          cacheCreation: 50,
          cacheCreation1h: 0,
          cacheCreation5m: 0,
          output: 88,
          context: 2150,
          serviceTier: null,
          webSearch: 0,
          webFetch: 0,
        },
      },
    ]);
    await writeTranscript([asstTurn("turn-1", 88)]);

    const result = await reconcileSession(transcriptPath, SESSION);
    expect(result.discrepancies).toHaveLength(0);
  });
});

describe("reconcileSession — compaction count gap fill", () => {
  test("emits only boundaries the log does not already account for", async () => {
    await appendEvents(SESSION, [
      {
        v: 1,
        ts: "2026-06-19T00:00:30.000Z",
        session: SESSION,
        workspace: "ws-alpha",
        event: "compaction_boundary",
        turnId: "turn-1",
        ctx: null,
      },
    ]);
    // Transcript shows exactly one compaction → already accounted for → none added.
    await writeTranscript([asstTurn("turn-1", 88), compactBoundaryLine(), asstTurn("turn-2", 5)]);

    const result = await reconcileSession(transcriptPath, SESSION);
    expect(result.byType.compaction_boundary).toBeUndefined();
    expect((await readLog()).filter((e) => e.event === "compaction_boundary")).toHaveLength(1);
  });
});
