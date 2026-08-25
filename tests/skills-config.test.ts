import { describe, expect, test } from "bun:test";
import { MAP_LABEL, splitSections } from "../src/core/board/view.ts";
import {
  renderDomainDoc,
  renderIssueTrackerDoc,
  renderTriageLabelsDoc,
  stampDoc,
} from "../src/core/skills-config.ts";

const WORKSPACE = "acme";

function generatedDocs(): Record<string, string> {
  return {
    "issue-tracker.md": renderIssueTrackerDoc(WORKSPACE),
    "domain.md": renderDomainDoc(),
    "triage-labels.md": renderTriageLabelsDoc(),
  };
}

describe("docs/agents/* — the contract servant publishes", () => {
  // The whole point of these docs post-#7: they describe the board, not one installed plugin. A
  // skill name that creeps back in is an instruction only that plugin's user can follow.
  test("no generated doc names a third-party plugin or one of its skills", () => {
    const forbidden = [
      "mattpocock",
      "matt-pocock",
      "/wayfinder",
      "/domain-modeling",
      "/grill-with-docs",
      "/improve-codebase-architecture",
      "/to-spec",
      "/to-tickets",
    ];
    for (const [name, body] of Object.entries(generatedDocs())) {
      for (const term of forbidden) {
        expect(body.toLowerCase(), `${name} names ${term}`).not.toContain(term);
      }
    }
  });

  // These docs replaced a GitHub-Issues tracker, and the failure mode they exist to prevent is an
  // agent reading a runnable `gh` invocation out of one. There is no repo behind this board.
  test("no generated doc contains a runnable gh invocation", () => {
    for (const [name, body] of Object.entries(generatedDocs())) {
      expect(body.match(/\bgh [a-z]/g) ?? [], name).toEqual([]);
    }
  });

  // Acceptance: a reader with no prior knowledge of servant can drive the board from this file
  // alone, so every operation it needs has to be spelled out with its real flags.
  test("issue-tracker.md spells out every board operation", () => {
    const doc = renderIssueTrackerDoc(WORKSPACE);
    for (const command of [
      "servant ticket new",
      "servant ticket show",
      "servant ticket comment",
      "servant ticket label",
      "servant ticket status",
      "servant ticket close",
      "servant ticket block",
      "servant ticket unblock",
      "servant claim",
      "servant tasks",
    ]) {
      expect(doc).toContain(command);
    }
    expect(doc).toContain(`--ws ${WORKSPACE}`);
  });

  test("triage-labels.md maps the five roles, with no foreign vocabulary column", () => {
    const doc = renderTriageLabelsDoc();
    for (const label of [
      "needs-triage",
      "needs-info",
      "ready-for-agent",
      "ready-for-human",
      "wontfix",
    ]) {
      expect(doc).toContain(label);
    }
    // One label column, one meaning column — three would mean a translation table again.
    const header = doc.split("\n").find((l) => l.startsWith("| Label"));
    expect(header?.split("|").filter((c) => c.trim()).length).toBe(2);
  });

  test("domain.md names the two locations it points a reader at", () => {
    const doc = renderDomainDoc();
    expect(doc).toContain("CONTEXT.md");
    expect(doc).toContain("docs/adr/");
  });

  // These docs are read by whatever is installed, so an instruction to invoke a specific slash
  // command is an instruction most readers cannot follow.
  test("no generated doc tells the reader to invoke a slash command", () => {
    for (const [name, body] of Object.entries(generatedDocs())) {
      const hits = body.match(/(?:^|[\s("'`])\/[a-z][a-z-]{2,}/g) ?? [];
      expect(hits, name).toEqual([]);
    }
  });
});

// The map vocabulary lives in prose but is read by code, so the two can drift silently. These lock
// the strings the doc tells a caller to type to the ones the board actually recognises.
describe("issue-tracker.md's map vocabulary matches the board", () => {
  test("the map label it names is the one the view reads", () => {
    expect(renderIssueTrackerDoc(WORKSPACE)).toContain(MAP_LABEL);
  });

  test("every map heading it names is a section the map view reads", () => {
    const doc = renderIssueTrackerDoc(WORKSPACE);
    const named = doc
      .split("\n")
      .map((l) => /^\s*## (.+)$/.exec(l)?.[1])
      .filter((h): h is string => h !== undefined)
      .filter((h) =>
        ["Destination", "Out of scope", "Decisions so far", "Not yet specified"].includes(h),
      )
      .toSorted();
    expect(named).toEqual(["Decisions so far", "Destination", "Not yet specified", "Out of scope"]);

    // What toMapView looks up, keyed exactly as splitSections stores it.
    const sections = splitSections(named.map((h) => `## ${h}\nbody\n`).join(""));
    expect([...sections.keys()].toSorted()).toEqual([
      "decisions so far",
      "destination",
      "not yet specified",
      "out of scope",
    ]);
  });

  test("the child types it names are the four the view distinguishes from a map", () => {
    const doc = renderIssueTrackerDoc(WORKSPACE);
    for (const type of ["research", "prototype", "grilling", "task"]) {
      expect(doc).toContain(`\`${type}\``);
    }
  });
});

describe("stampDoc", () => {
  test("stamps the content, so moving the prose moves the stamp", () => {
    const first = stampDoc("one\n");
    const second = stampDoc("two\n");
    expect(first.split("\n")[0]).not.toBe(second.split("\n")[0]);
    expect(stampDoc("one\n")).toBe(first);
  });
});
