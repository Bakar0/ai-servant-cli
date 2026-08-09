import { describe, expect, test } from "bun:test";
import { createLiveCallLogView, formatCallLogEntry } from "../src/core/call-log/live.ts";
import type { CallLogEntry } from "../src/core/call-log/record.ts";

/** The live view is tested through its injected `write`, so no real terminal is involved. */
function watched(entries: CallLogEntry[]): string[] {
  const lines: string[] = [];
  const view = createLiveCallLogView({ write: (line) => lines.push(line) });
  for (const entry of entries) view.record(entry);
  return lines;
}

describe("watching a Summons live", () => {
  test("shows both sides of the conversation, labelled and in order", () => {
    const lines = watched([
      { type: "said", who: "user", text: "how's the delegation ticket going" },
      { type: "said", who: "servant", text: "it's mid-implement, three files changed so far" },
    ]);
    expect(lines).toEqual([
      "you    ▸ how's the delegation ticket going",
      "agent  ▸ it's mid-implement, three files changed so far",
    ]);
  });

  test("collapses a multi-line utterance onto one line, so the view stays scannable", () => {
    const [line] = watched([{ type: "said", who: "servant", text: "one\n\ntwo   three\n" }]);
    expect(line).toBe("agent  ▸ one two three");
  });

  test("shows a tool call with what it touched and how long it took", () => {
    const [line] = watched([
      { type: "tool", name: "read_file", target: "GOAL.md", outcome: "ok", durationMs: 12 },
    ]);
    expect(line).toContain("read_file");
    expect(line).toContain("GOAL.md");
    expect(line).toContain("12ms");
  });

  test("reports seconds once a call stops being instant", () => {
    const [line] = watched([
      { type: "hands", request: "run the tests", response: null, outcome: "ok", durationMs: 4200 },
    ]);
    expect(line).toContain("hands");
    expect(line).toContain("4.2s");
  });

  test("shows a request that is still running, so working is not mistaken for hung", () => {
    const [line] = watched([{ type: "hands-asked", request: "run the whole suite" }]);
    expect(line).toContain("hands");
    expect(line).toContain("run the whole suite");
    expect(line).toContain("working");
  });

  test("shows what the Hands session came back with — its only visible trace", () => {
    const lines = watched([
      {
        type: "hands",
        request: "run the tests",
        response: "all green, 462 passing",
        outcome: "ok",
        durationMs: 4200,
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("all green, 462 passing");
  });

  test("says a tool failed, and why", () => {
    const [line] = watched([
      {
        type: "tool",
        name: "read_file",
        target: "nope.md",
        outcome: "error",
        detail: "no such file",
        durationMs: 2,
      },
    ]);
    expect(line).toContain("failed");
    expect(line).toContain("no such file");
  });

  test("shows a held delegation as held — nothing has run", () => {
    const [line] = watched([
      {
        type: "tool",
        name: "delegate",
        target: "the auth refactor",
        outcome: "held",
        durationMs: 0,
      },
    ]);
    expect(line).toContain("held");
    expect(line).not.toContain("launched");
  });

  test("shows the gate's verdict and the words it was read from", () => {
    const [line] = watched([
      { type: "gate", label: "the auth refactor", verdict: "confirmed", heard: "yeah go ahead" },
    ]);
    expect(line).toContain("confirmed");
    expect(line).toContain("yeah go ahead");
  });

  test("shows which session a delegation was spawned into", () => {
    const [line] = watched([
      {
        type: "delegation",
        mode: "delegate",
        label: "the auth refactor",
        task: "refactor auth",
        session: "ai-servant-t28",
        status: "launched",
      },
    ]);
    expect(line).toContain("ai-servant-t28");
  });

  test("shows a queued delegation as waiting, not running", () => {
    const [line] = watched([
      {
        type: "delegation",
        mode: "delegate",
        label: "the second one",
        task: "do it",
        session: null,
        status: "queued",
        detail: "the auth refactor",
      },
    ]);
    expect(line).toContain("queued behind the auth refactor");
  });

  test("shows errors and the hang-up", () => {
    expect(watched([{ type: "note", level: "error", text: "socket closed" }])[0]).toContain(
      "! socket closed",
    );
    expect(watched([{ type: "ended", reason: "idle" }])[0]).toContain("Summons ended (idle)");
  });

  test("clips a long target so the columns stay aligned", () => {
    const [line] = watched([
      {
        type: "tool",
        name: "grep",
        target: "a".repeat(120),
        outcome: "ok",
        durationMs: 5,
      },
    ]);
    expect(line?.length).toBeLessThan(90);
    expect(line).toContain("…");
  });

  test("every entry the record can hold renders as at least one line", () => {
    const all: CallLogEntry[] = [
      { type: "said", who: "user", text: "hi" },
      { type: "tool", name: "glob", target: "**/*.md", outcome: "ok", durationMs: 1 },
      { type: "gate", label: "x", verdict: "unclear", heard: "uh" },
      {
        type: "delegation",
        mode: "research",
        label: "y",
        task: "t",
        session: "s",
        status: "launched",
      },
      { type: "hands", request: "r", response: null, outcome: "error", durationMs: 1 },
      { type: "note", level: "info", text: "n" },
      { type: "ended", reason: "closed" },
    ];
    for (const entry of all) expect(formatCallLogEntry(entry).length).toBeGreaterThan(0);
  });
});
