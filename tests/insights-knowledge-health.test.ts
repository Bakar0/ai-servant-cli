import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanKnowledgeHealth } from "../src/core/insights/knowledge-health.ts";
import { type KnowledgeNote, noteFilePath, upsertNote } from "../src/core/knowledge.ts";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
const NOW = Date.parse("2026-06-18T00:00:00Z");

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-insights-kh-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const note = (over: Partial<KnowledgeNote>): KnowledgeNote => ({
  name: "n",
  description: "d",
  scope: "topic",
  tags: [],
  source: {},
  confidence: "high",
  body: "body",
  ...over,
});

describe("scanKnowledgeHealth", () => {
  test("flags low confidence, orphan tags, stale, and dead notes", async () => {
    await upsertNote(
      note({
        name: "fresh-used",
        tags: ["auth", "shared"],
        confidence: "high",
        source: { date: "2026-06-01" },
      }),
    );
    await upsertNote(
      note({
        name: "low-orphan",
        tags: ["orphan", "shared"],
        confidence: "low",
        source: { date: "2026-06-10" },
      }),
    );
    await upsertNote(
      note({ name: "stale-note", tags: ["shared"], source: { date: "2024-01-01" } }),
    );

    // Only the first note was ever read.
    const readNoteFiles = new Set<string>([noteFilePath("topic", "fresh-used")]);
    const h = await scanKnowledgeHealth({ readNoteFiles, now: NOW });

    expect(h.totalNotes).toBe(3);
    expect(h.byScope.topic).toBe(3);
    expect(h.confidence.high).toBe(2);
    expect(h.confidence.low).toBe(1);

    // "orphan" and "auth" appear once; "shared" appears 3× and is not an orphan.
    expect(h.orphanTags).toContain("orphan");
    expect(h.orphanTags).toContain("auth");
    expect(h.orphanTags).not.toContain("shared");

    // stale-note's date is far past the 6-month window.
    expect(h.stale.map((s) => s.name)).toContain("stale-note");
    expect(h.stale.map((s) => s.name)).not.toContain("low-orphan");

    // dead = never read: everything except fresh-used.
    const deadNames = h.dead.map((d) => d.name).toSorted();
    expect(deadNames).toEqual(["low-orphan", "stale-note"]);
  });

  test("flags a note that cites a missing absolute file path as rotted", async () => {
    const missing = join(tmpRoot, "does", "not", "exist.ts");
    await upsertNote(note({ name: "rotted", body: `See ${missing} for details.` }));
    const h = await scanKnowledgeHealth({ now: NOW });
    expect(h.rotted.map((r) => r.name)).toContain("rotted");
  });
});
