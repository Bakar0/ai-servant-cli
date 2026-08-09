import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  callLogId,
  listCallLogs,
  openCallLog,
  readCallLog,
  resolveCallLogId,
} from "../src/core/call-log/store.ts";
import { callLogPath, callLogsRoot, setRootOverride } from "../src/core/paths.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "servant-call-log-test-"));
  setRootOverride(root);
});

afterAll(async () => {
  setRootOverride(null);
  await rm(root, { recursive: true, force: true });
});

/** A clock that advances a fixed step per read, so stamps are asserted rather than waited for. */
function fakeClock(startIso: string, stepMs = 1000) {
  let at = Date.parse(startIso);
  return () => {
    const now = new Date(at);
    at += stepMs;
    return now;
  };
}

const HEADER = {
  workspace: "demo",
  scope: "workspace demo",
  model: "gpt-realtime",
  voice: "marin",
};

async function linesOf(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("call log ids", () => {
  test("names a log after its workspace and when it happened", () => {
    expect(callLogId("ai_servant", new Date("2026-08-09T10:45:12"))).toBe(
      "ai-servant-20260809-104512",
    );
  });
});

describe("writing a call log", () => {
  test("writes the header first, then one line per entry, in order and stamped", async () => {
    const log = await openCallLog({ ...HEADER, now: fakeClock("2026-08-09T10:00:00.000Z") });
    log.port.record({ type: "said", who: "user", text: "how's the delegation ticket going" });
    log.port.record({ type: "said", who: "servant", text: "it's mid-implement" });
    log.port.record({
      type: "tool",
      name: "read_file",
      target: "GOAL.md",
      outcome: "ok",
      durationMs: 12,
    });
    await log.close();

    const lines = await linesOf(log.path);
    expect(lines.map((l) => l.type)).toEqual(["opened", "said", "said", "tool"]);
    expect(lines[0]).toMatchObject({ workspace: "demo", scope: "workspace demo", id: log.id });
    expect(lines[1]).toMatchObject({ who: "user", at: "2026-08-09T10:00:01.000Z" });
    expect(lines[3]).toMatchObject({ name: "read_file", target: "GOAL.md", durationMs: 12 });
  });

  test("is on disk as it happens — killing the process mid-conversation keeps what came before", async () => {
    const log = await openCallLog({ ...HEADER, workspace: "killed" });
    log.port.record({ type: "said", who: "user", text: "start the thing" });
    await log.close();

    // No `ended` entry is ever written: this is the process dying mid-sentence.
    const contents = await readCallLog(log.id);
    expect(contents?.summary.endReason).toBeNull();
    expect(contents?.summary.utterances).toBe(1);
  });

  test("a torn final line is skipped, not treated as corruption", async () => {
    const log = await openCallLog({ ...HEADER, workspace: "torn" });
    log.port.record({ type: "said", who: "user", text: "hello" });
    await log.close();
    await writeFile(log.path, `${await readFile(log.path, "utf8")}{"type":"said","wh`);

    const contents = await readCallLog(log.id);
    expect(contents?.summary.utterances).toBe(1);
  });

  test("two Summonses opened in the same second get their own files", async () => {
    const clock = () => new Date("2026-08-09T11:00:00.000Z");
    const first = await openCallLog({ ...HEADER, workspace: "same", now: clock });
    const second = await openCallLog({ ...HEADER, workspace: "same", now: clock });
    await Promise.all([first.close(), second.close()]);

    expect(second.id).not.toBe(first.id);
    expect(second.path).not.toBe(first.path);
  });

  test("a failed write is reported, never thrown into the conversation", async () => {
    const failures: string[] = [];
    const log = await openCallLog({
      ...HEADER,
      workspace: "unwritable",
      onWriteError: (m) => failures.push(m),
    });
    // Replace the record with a directory, so every further append fails at the OS.
    await rm(log.path);
    await Bun.write(join(log.path, "blocker"), "x");

    expect(() => log.port.record({ type: "said", who: "user", text: "hi" })).not.toThrow();
    await log.close();
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe("reading call logs back", () => {
  test("summarises what a Summons was without reading every word of it", async () => {
    const log = await openCallLog({
      ...HEADER,
      workspace: "counted",
      now: fakeClock("2026-08-09T12:00:00.000Z"),
    });
    log.port.record({ type: "said", who: "user", text: "do the thing" });
    log.port.record({
      type: "tool",
      name: "glob",
      target: "docs/**",
      outcome: "ok",
      durationMs: 4,
    });
    log.port.record({
      type: "delegation",
      mode: "delegate",
      label: "the auth refactor",
      task: "refactor auth",
      session: "counted-t28",
      status: "launched",
    });
    log.port.record({
      type: "hands",
      request: "run the tests",
      response: "all green",
      outcome: "ok",
      durationMs: 4200,
    });
    log.port.record({ type: "ended", reason: "hung up" });
    await log.close();

    const contents = await readCallLog(log.id);
    expect(contents?.summary).toMatchObject({
      workspace: "counted",
      utterances: 1,
      tools: 1,
      delegations: 1,
      handsCalls: 1,
      endReason: "hung up",
    });
    expect(contents?.records).toHaveLength(6);
  });

  test("lists past Summonses newest first, and narrows to one workspace", async () => {
    const older = await openCallLog({
      ...HEADER,
      workspace: "listed",
      now: fakeClock("2026-01-01T09:00:00.000Z"),
    });
    await older.close();
    const newer = await openCallLog({
      ...HEADER,
      workspace: "listed",
      now: fakeClock("2026-02-01T09:00:00.000Z"),
    });
    await newer.close();

    const logs = await listCallLogs({ workspace: "listed" });
    expect(logs.map((l) => l.id)).toEqual([newer.id, older.id]);
    expect(await listCallLogs({ workspace: "nobody" })).toEqual([]);
  });

  test("reopens a past Summons by `latest`, by id, or by enough of one", async () => {
    const log = await openCallLog({
      ...HEADER,
      workspace: "resolved",
      now: fakeClock("2026-03-03T09:30:00.000Z"),
    });
    await log.close();

    expect(await resolveCallLogId("latest", { workspace: "resolved" })).toEqual({ id: log.id });
    expect(await resolveCallLogId(undefined, { workspace: "resolved" })).toEqual({ id: log.id });
    expect(await resolveCallLogId(log.id)).toEqual({ id: log.id });
    expect(await resolveCallLogId("20260303-0930", { workspace: "resolved" })).toEqual({
      id: log.id,
    });
  });

  test("says so rather than guessing when a reference matches nothing or several things", async () => {
    const first = await openCallLog({
      ...HEADER,
      workspace: "ambiguous",
      now: fakeClock("2026-04-01T09:00:00.000Z"),
    });
    await first.close();
    const second = await openCallLog({
      ...HEADER,
      workspace: "ambiguous",
      now: fakeClock("2026-04-02T09:00:00.000Z"),
    });
    await second.close();

    const missing = await resolveCallLogId("nope", { workspace: "ambiguous" });
    expect(missing).toEqual({ error: 'No Call log matching "nope".' });
    const several = await resolveCallLogId("ambiguous-2026", { workspace: "ambiguous" });
    expect("error" in several && several.error).toContain("matches 2 Call logs");
  });

  test("an absent record reads as nothing, not as a crash", async () => {
    expect(await readCallLog("never-existed")).toBeNull();
  });

  test("everything is written to servant's own store, never a workspace or a repo", async () => {
    const log = await openCallLog({ ...HEADER, workspace: "placed" });
    await log.close();
    expect(callLogsRoot()).toBe(join(root, "call-logs"));
    expect(log.path).toBe(callLogPath(log.id));
    expect(log.path.startsWith(join(root, "call-logs"))).toBe(true);
  });
});
