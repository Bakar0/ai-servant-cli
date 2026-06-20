import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrain, runFromHook, runReconcile } from "../src/commands/extract-memories.ts";
import {
  type ExtractJob,
  acquireLock,
  getMarker,
  queueDepth,
  readDrainStatus,
  readJobs,
  releaseLock,
} from "../src/core/extract-queue.ts";
import {
  extractLockPath,
  knowledgeIndexPath,
  knowledgeTopicsDir,
  setRootOverride,
  workspacesRoot,
} from "../src/core/paths.ts";

let tmpRoot: string;
let wsCwd: string;
let transcript: string;

async function makeTranscript(path: string, entries: number): Promise<void> {
  const lines = Array.from({ length: entries }, (_, i) =>
    JSON.stringify({ type: i % 2 ? "assistant" : "user", message: { role: "user" } }),
  );
  await writeFile(path, `${lines.join("\n")}\n`);
}

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "11111111-1111-1111-1111-111111111111",
    transcript_path: transcript,
    cwd: wsCwd,
    reason: "clear",
    ...over,
  });
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-extract-"));
  setRootOverride(tmpRoot);
  wsCwd = join(workspacesRoot(), "ws");
  await mkdir(wsCwd, { recursive: true });
  transcript = join(tmpRoot, "transcript.jsonl");
  await makeTranscript(transcript, 10);
  process.env.SERVANT_EXTRACTION = ""; // falsy reset (delete is flagged by biome)
});

afterEach(async () => {
  process.env.SERVANT_EXTRACTION = ""; // falsy reset (delete is flagged by biome)
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("runFromHook guards", () => {
  test("enqueues a valid servant session", async () => {
    await runFromHook(payload(), { kick: false });
    const jobs = await readJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.workspace).toBe("ws");
    expect(jobs[0]?.cwd).toBe(wsCwd);
  });

  test("SERVANT_EXTRACTION set → no enqueue (the extraction's own session)", async () => {
    process.env.SERVANT_EXTRACTION = "1";
    await runFromHook(payload(), { kick: false });
    expect(await queueDepth()).toBe(0);
  });

  test("SERVANT_INSIGHTS set → no enqueue (the judge's own headless session)", async () => {
    process.env.SERVANT_INSIGHTS = "1";
    try {
      await runFromHook(payload(), { kick: false });
      expect(await queueDepth()).toBe(0);
    } finally {
      process.env.SERVANT_INSIGHTS = "";
    }
  });

  test("cwd outside workspaces root → no enqueue", async () => {
    await runFromHook(payload({ cwd: "/tmp/elsewhere" }), { kick: false });
    expect(await queueDepth()).toBe(0);
  });

  test("missing transcript → no enqueue", async () => {
    await runFromHook(payload({ transcript_path: join(tmpRoot, "nope.jsonl") }), { kick: false });
    expect(await queueDepth()).toBe(0);
  });

  test("too few transcript entries → no enqueue", async () => {
    await makeTranscript(transcript, 3);
    await runFromHook(payload(), { kick: false });
    expect(await queueDepth()).toBe(0);
  });

  test("malformed payload → no throw, no enqueue", async () => {
    await runFromHook("not json", { kick: false });
    expect(await queueDepth()).toBe(0);
  });
});

describe("runDrain", () => {
  test("processes each session once, advances the turn marker", async () => {
    await runFromHook(payload(), { kick: false });
    const calls: ExtractJob[] = [];
    const result = await runDrain({
      runner: async (job) => {
        calls.push(job);
        return "";
      },
    });
    expect(result).toEqual({ processed: 1, skipped: false });
    expect(calls).toHaveLength(1);
    expect(await getMarker("11111111-1111-1111-1111-111111111111")).toBe(10);
    expect(await queueDepth()).toBe(0); // queue drained
  });

  test("dedupes a burst of /clears for the same session into one extraction", async () => {
    await runFromHook(payload(), { kick: false });
    await runFromHook(payload(), { kick: false });
    await runFromHook(payload(), { kick: false });
    expect(await queueDepth()).toBe(3);
    let count = 0;
    await runDrain({
      runner: async () => {
        count += 1;
        return "";
      },
    });
    expect(count).toBe(1);
  });

  test("skips a session with no new turns since the last marker", async () => {
    await runFromHook(payload(), { kick: false });
    await runDrain({ runner: async () => "" }); // marker → 10
    await runFromHook(payload(), { kick: false }); // same transcript, still 10 entries
    let count = 0;
    const result = await runDrain({
      runner: async () => {
        count += 1;
        return "";
      },
    });
    expect(count).toBe(0);
    expect(result.processed).toBe(0);
  });

  test("records each job's summary line in the drain status", async () => {
    await runFromHook(payload(), { kick: false });
    await runDrain({ runner: async () => "added/updated 2 notes" });
    const status = await readDrainStatus();
    expect(status?.summaries).toEqual(["added/updated 2 notes"]);
  });

  test("records a runner error in the drain status without throwing", async () => {
    await runFromHook(payload(), { kick: false });
    await runDrain({
      runner: async () => {
        throw new Error("claude blew up");
      },
    });
    const status = await readDrainStatus();
    expect(status?.error).toContain("claude blew up");
    expect(status?.processed).toBe(0);
  });

  test("is a no-op when the lock is already held (serialization)", async () => {
    await runFromHook(payload(), { kick: false });
    expect(await acquireLock()).toBe(true); // simulate another drainer holding the lock
    try {
      const result = await runDrain({ runner: async () => "" });
      expect(result.skipped).toBe(true);
      expect(await queueDepth()).toBe(1); // untouched
    } finally {
      await releaseLock();
    }
  });
});

describe("lock", () => {
  test("steals a lock held by a dead process", async () => {
    await mkdir(join(tmpRoot, ".cache"), { recursive: true });
    await writeFile(extractLockPath(), JSON.stringify({ pid: 2147483646, ts: Date.now() }));
    expect(await acquireLock()).toBe(true);
    await releaseLock();
  });
});

describe("runReconcile", () => {
  test("rebuilds the master index from notes on disk and commits", async () => {
    await mkdir(knowledgeTopicsDir(), { recursive: true });
    await writeFile(
      join(knowledgeTopicsDir(), "wal.md"),
      "---\nname: wal\ndescription: WAL note\nscope: topic\ntags: [bun, sqlite]\nsource: { date: 2026-06-16 }\nconfidence: high\n---\nbody\n",
    );
    await runReconcile("memory: test");
    const master = await readFile(knowledgeIndexPath(), "utf8");
    expect(master).toContain("bun(1)");
    expect(master).toContain("sqlite(1)");
  });
});
