import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type KnowledgeNote,
  ensureProjectIndex,
  listAllNotes,
  noteScopeLabel,
  parseNote,
  rebuildMasterIndex,
  renderNote,
  searchNotes,
  serializeNote,
  slugify,
  topicTagCounts,
  upsertNote,
} from "../src/core/knowledge.ts";
import {
  knowledgeIndexPath,
  knowledgeProjectIndexPath,
  knowledgeTopicsDir,
  setRootOverride,
} from "../src/core/paths.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-knowledge-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const topicNote = (over: Partial<KnowledgeNote> = {}): KnowledgeNote => ({
  name: "wal-gotcha",
  description: "Bun SQLite WAL gotcha",
  scope: "topic",
  tags: ["bun", "sqlite"],
  source: { session: "abc", date: "2026-06-16", commit: "e1a6cb6" },
  confidence: "high",
  body: "WAL mode requires X.",
  ...over,
});

describe("frontmatter round-trip", () => {
  test("serialize then parse preserves all fields", () => {
    const note = topicNote();
    const parsed = parseNote(serializeNote(note));
    expect(parsed).toEqual(note);
  });

  test("project scope serializes scope and omits empty topic tags", () => {
    const note = topicNote({
      name: "auth-flow",
      scope: "project/api-gw",
      tags: [],
      body: "Auth lives in X.",
    });
    const text = serializeNote(note);
    expect(text).toContain("scope: project/api-gw");
    expect(text).not.toContain("tags:");
    expect(parseNote(text)).toEqual(note);
  });
});

describe("slugify", () => {
  test("kebab-cases arbitrary text", () => {
    expect(slugify("Bun SQLite WAL Gotcha!")).toBe("bun-sqlite-wal-gotcha");
  });
});

describe("upsertNote + dedup", () => {
  test("create then update by name+scope writes one file", async () => {
    expect(await upsertNote(topicNote())).toBe("created");
    expect(await upsertNote(topicNote({ description: "changed" }))).toBe("updated");
    const path = join(knowledgeTopicsDir(), "wal-gotcha.md");
    const parsed = parseNote(await readFile(path, "utf8"));
    expect(parsed.description).toBe("changed");
  });

  test("same name in different scope is a distinct note", async () => {
    await upsertNote(topicNote({ name: "shared" }));
    await upsertNote(topicNote({ name: "shared", scope: "project/api-gw", tags: [] }));
    const topic = await readFile(join(knowledgeTopicsDir(), "shared.md"), "utf8");
    const proj = await readFile(knowledgeProjectIndexPath("api-gw"), "utf8");
    expect(topic).toContain("scope: topic");
    expect(proj).toContain("shared");
  });
});

describe("project index reconcile", () => {
  test("lists notes as bullet links", async () => {
    await upsertNote(topicNote({ name: "auth-flow", scope: "project/api-gw", tags: [] }));
    await upsertNote(
      topicNote({
        name: "build-flakiness",
        scope: "project/api-gw",
        tags: [],
        description: "flaky build",
      }),
    );
    const index = await readFile(knowledgeProjectIndexPath("api-gw"), "utf8");
    expect(index).toContain("- [auth-flow](auth-flow.md)");
    expect(index).toContain("- [build-flakiness](build-flakiness.md) — flaky build");
  });

  test("ensureProjectIndex creates an empty index", async () => {
    await ensureProjectIndex("billing");
    const index = await readFile(knowledgeProjectIndexPath("billing"), "utf8");
    expect(index).toContain("# billing");
    expect(index).toContain("_No notes yet._");
  });
});

describe("thin master index", () => {
  test("links projects with counts and lists topic tag directory", async () => {
    await upsertNote(topicNote()); // bun, sqlite
    await upsertNote(topicNote({ name: "id-match", tags: ["cmux", "bun"] }));
    await upsertNote(topicNote({ name: "auth", scope: "project/api-gw", tags: [] }));
    await rebuildMasterIndex();
    const master = await readFile(knowledgeIndexPath(), "utf8");
    expect(master).toContain("- [api-gw](projects/api-gw/INDEX.md) — 1 notes");
    expect(master).toContain("tags:");
    expect(master).toContain("bun(2)");
    expect(master).toContain("sqlite(1)");
  });

  test("topicTagCounts ranks by frequency", async () => {
    await upsertNote(topicNote()); // bun, sqlite
    await upsertNote(topicNote({ name: "n2", tags: ["bun"] }));
    const counts = await topicTagCounts();
    expect(counts[0]).toEqual({ tag: "bun", count: 2 });
  });
});

describe("listAllNotes + display helpers", () => {
  test("listAllNotes returns every note (projects + topics) with its path", async () => {
    await upsertNote(topicNote());
    await upsertNote(topicNote({ name: "auth", scope: "project/api-gw", tags: [] }));
    const all = await listAllNotes();
    expect(all.map((s) => s.note.name).toSorted()).toEqual(["auth", "wal-gotcha"]);
    expect(all.every((s) => s.path.endsWith(".md"))).toBe(true);
  });

  test("noteScopeLabel distinguishes project and topic", () => {
    expect(noteScopeLabel(topicNote())).toBe("topic [bun, sqlite]");
    expect(noteScopeLabel(topicNote({ scope: "project/api-gw" }))).toBe("project/api-gw");
  });

  test("renderNote includes name, body, source and path", () => {
    const out = renderNote(topicNote(), "/x/wal-gotcha.md");
    expect(out).toContain("# wal-gotcha");
    expect(out).toContain("WAL mode requires X.");
    expect(out).toContain("2026-06-16");
    expect(out).toContain("/x/wal-gotcha.md");
  });
});

describe("searchNotes", () => {
  test("ranks tag matches above body matches", async () => {
    await upsertNote(topicNote({ name: "tagged", tags: ["sqlite"], body: "nothing here" }));
    await upsertNote(topicNote({ name: "bodied", tags: ["unrelated"], body: "mentions sqlite" }));
    const hits = await searchNotes("sqlite");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.note.name).toBe("tagged");
  });

  test("searches across projects and topics", async () => {
    await upsertNote(topicNote({ name: "auth", scope: "project/api-gw", tags: [], body: "jwt" }));
    await upsertNote(topicNote({ name: "topic-jwt", body: "jwt rotation" }));
    const hits = await searchNotes("jwt");
    expect(hits.map((h) => h.note.name).toSorted()).toEqual(["auth", "topic-jwt"]);
  });

  test("no match returns empty", async () => {
    await upsertNote(topicNote());
    expect(await searchNotes("nonexistent")).toHaveLength(0);
  });
});
