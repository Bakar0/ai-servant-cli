import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InsightEvent,
  assistantTurns,
  parseTranscriptLines,
  parseUsage,
  recordHookEvent,
} from "../src/core/insights/events.ts";
import { insightsEventLogPath, setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
let cwd: string;
let transcriptPath: string;
const SESSION = "11111111-2222-3333-4444-555555555555";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-insights-events-"));
  setRootOverride(tmpRoot);
  cwd = join(tmpRoot, "workspaces", "ws-alpha");
  await mkdir(cwd, { recursive: true });
  transcriptPath = join(tmpRoot, "transcript.jsonl");
});

afterEach(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** An assistant turn line carrying a usage block. */
function asstTurn(uuid: string, out: number, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid,
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

function payload(extra: Record<string, unknown>): Record<string, unknown> {
  return { session_id: SESSION, transcript_path: transcriptPath, cwd, ...extra };
}

describe("parseUsage", () => {
  test("normalizes context, cache TTL split, and server tool use", () => {
    const u = parseUsage({
      input_tokens: 10,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 500,
      output_tokens: 7,
      service_tier: "standard",
      cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
    });
    expect(u).not.toBeNull();
    expect(u?.context).toBe(1510); // input + cacheRead + cacheCreation
    expect(u?.cacheCreation1h).toBe(500);
    expect(u?.webSearch).toBe(2);
    expect(u?.serviceTier).toBe("standard");
  });
});

describe("assistantTurns", () => {
  const userLine = { type: "user", message: { role: "user", content: "result" } };

  test("collapses one logical turn split across lines with different uuids but identical usage", () => {
    // The real shape: a thinking line and a tool_use line, distinct uuids, same usage block.
    const lines = parseTranscriptLines(
      [asstTurn("a-think", 107), asstTurn("a-tool", 107), userLine, asstTurn("b", 5)]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    expect(assistantTurns(lines).map((t) => t.uuid)).toEqual(["a-think", "b"]);
  });

  test("does not merge two real turns that happen to share a usage signature", () => {
    // A non-assistant line between them resets the run, so both are kept.
    const lines = parseTranscriptLines(
      [asstTurn("t1", 88), userLine, asstTurn("t2", 88)].map((l) => JSON.stringify(l)).join("\n"),
    );
    expect(assistantTurns(lines).map((t) => t.uuid)).toEqual(["t1", "t2"]);
  });
});

describe("recordHookEvent enrichment", () => {
  test("tool_end is correlated to the issuing assistant turn's context", async () => {
    await writeTranscript([asstTurn("turn-1", 88)]);
    await recordHookEvent(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/x/big.ts" },
        tool_output: "y".repeat(4000),
      }),
    );
    const log = await readLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.event).toBe("tool_end");
    expect(log[0]?.tool).toBe("Read");
    expect(log[0]?.target).toBe("/x/big.ts");
    expect(log[0]?.resultChars).toBe(4000);
    expect(log[0]?.turnId).toBe("turn-1");
    expect(log[0]?.ctx?.context).toBe(2150);
  });

  test("ignores sessions outside a servant workspace", async () => {
    await writeTranscript([asstTurn("turn-1", 88)]);
    await recordHookEvent({
      session_id: SESSION,
      transcript_path: transcriptPath,
      cwd: "/tmp/not-a-workspace",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
    });
    await expect(readFile(insightsEventLogPath(SESSION), "utf8")).rejects.toThrow();
  });
});

describe("Stop lag + idempotent turn sync", () => {
  test("a turn lands once across the lagging Stop and the SessionEnd sweep", async () => {
    // Fire 1: at the first Stop, only the tool-issuing turn is flushed (the probe's finding).
    await writeTranscript([asstTurn("turn-1", 88)]);
    await recordHookEvent(payload({ hook_event_name: "Stop", effort: "high" }));

    // Fire 2: the final turn has now been flushed; Stop fires again.
    await writeTranscript([asstTurn("turn-1", 88), asstTurn("turn-2", 5)]);
    await recordHookEvent(payload({ hook_event_name: "Stop" }));

    // SessionEnd sweep: nothing new to emit for turns, plus the session_end marker.
    await recordHookEvent(payload({ hook_event_name: "SessionEnd", reason: "other" }));

    const log = await readLog();
    const turns = log.filter((e) => e.event === "turn_complete");
    expect(turns.map((t) => t.turnId)).toEqual(["turn-1", "turn-2"]); // each exactly once
    expect(turns[0]?.effort).toBe("high");
    expect(log.at(-1)?.event).toBe("session_end");
    expect(log.at(-1)?.reason).toBe("other");
  });

  test("SessionEnd sweeps a final turn that Stop never saw", async () => {
    await writeTranscript([asstTurn("turn-1", 88)]);
    await recordHookEvent(payload({ hook_event_name: "Stop" }));
    // turn-2 only ever appears by SessionEnd (e.g. a fast exit cancelled the last Stop).
    await writeTranscript([asstTurn("turn-1", 88), asstTurn("turn-2", 5)]);
    await recordHookEvent(payload({ hook_event_name: "SessionEnd", reason: "logout" }));

    const turns = (await readLog()).filter((e) => e.event === "turn_complete");
    expect(turns.map((t) => t.turnId)).toEqual(["turn-1", "turn-2"]);
  });
});

describe("compaction signals", () => {
  test("PreCompact records trigger; SessionStart(source=compact) marks a boundary", async () => {
    await writeTranscript([asstTurn("turn-1", 88)]);
    await recordHookEvent(payload({ hook_event_name: "PreCompact", trigger: "manual" }));
    await recordHookEvent(
      payload({ hook_event_name: "SessionStart", source: "compact", model: "claude-opus-4-8" }),
    );
    await recordHookEvent(payload({ hook_event_name: "SessionStart", source: "startup" }));

    const log = await readLog();
    expect(log.find((e) => e.event === "compact")?.trigger).toBe("manual");
    const boundary = log.find((e) => e.event === "compaction_boundary");
    expect(boundary?.model).toBe("claude-opus-4-8");
    expect(log.find((e) => e.event === "session_start")?.source).toBe("startup");
  });
});

describe("prompt events", () => {
  test("captures prompt length and a leading slash command", async () => {
    await writeTranscript([asstTurn("turn-1", 88)]);
    await recordHookEvent(
      payload({ hook_event_name: "UserPromptSubmit", prompt: "/servant:goal do it" }),
    );
    const e = (await readLog())[0];
    expect(e?.event).toBe("prompt");
    expect(e?.slashCommand).toBe("/servant:goal");
    expect(e?.promptChars).toBe("/servant:goal do it".length);
  });
});
