import { describe, expect, test } from "bun:test";
import { buildCallLogViewData, renderCallLog } from "../src/core/call-log/render.ts";
import type { CallLogContents, CallLogSummary } from "../src/core/call-log/store.ts";

const SUMMARY: CallLogSummary = {
  id: "demo-20260809-104512",
  workspace: "demo",
  scope: "workspace demo",
  model: "gpt-realtime",
  voice: "marin",
  path: "/tmp/demo-20260809-104512.jsonl",
  startedAt: "2026-08-09T10:45:12.000Z",
  endedAt: "2026-08-09T10:52:12.000Z",
  endReason: "hung up",
  utterances: 2,
  tools: 1,
  delegations: 1,
  handsCalls: 1,
};

const CONTENTS: CallLogContents = {
  summary: SUMMARY,
  records: [
    { type: "opened", at: SUMMARY.startedAt, ...SUMMARY },
    { type: "said", at: "2026-08-09T10:45:20.000Z", who: "user", text: "how's the ticket going" },
    { type: "said", at: "2026-08-09T10:45:24.000Z", who: "servant", text: "mid-implement" },
    {
      type: "tool",
      at: "2026-08-09T10:45:30.000Z",
      name: "read_file",
      target: "GOAL.md",
      outcome: "ok",
      durationMs: 12,
    },
    {
      type: "delegation",
      at: "2026-08-09T10:46:00.000Z",
      mode: "delegate",
      label: "the auth refactor",
      task: "refactor auth",
      session: "demo-t28",
      status: "launched",
    },
    {
      type: "hands",
      at: "2026-08-09T10:47:00.000Z",
      request: "run the tests",
      response: "all green",
      outcome: "ok",
      durationMs: 4200,
    },
    { type: "ended", at: SUMMARY.endedAt as string, reason: "hung up" },
  ],
};

/** The page's single JSON slot, read back the way the browser would. */
function payload(html: string): { summary: Record<string, unknown>; entries: unknown[] } {
  const match = html.match(
    /<script id="call-log-data" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error("no data slot in the rendered page");
  return JSON.parse(match[1].replace(/<\\\//g, "</"));
}

describe("call log view data", () => {
  test("derives how long the Summons lasted from the record itself", () => {
    expect(buildCallLogViewData(CONTENTS).summary.durationMs).toBe(7 * 60 * 1000);
  });

  test("leaves the duration unknown when the Summons was cut off", () => {
    const cutOff: CallLogContents = {
      summary: { ...SUMMARY, endedAt: null, endReason: null },
      records: CONTENTS.records.slice(0, -1),
    };
    expect(buildCallLogViewData(cutOff).summary.durationMs).toBeNull();
  });
});

describe("rendering a call log", () => {
  test("carries the whole record into the page's single data slot", () => {
    const data = payload(renderCallLog(CONTENTS));
    expect(data.summary).toMatchObject({ id: SUMMARY.id, workspace: "demo", endReason: "hung up" });
    expect(data.entries).toHaveLength(CONTENTS.records.length);
  });

  test("keeps what the Hands session did and which session was delegated to", () => {
    const json = JSON.stringify(payload(renderCallLog(CONTENTS)));
    expect(json).toContain("demo-t28");
    expect(json).toContain("run the tests");
    expect(json).toContain("all green");
  });

  test("is self-contained and offline — no network reference of any kind", () => {
    const html = renderCallLog(CONTENTS);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest|WebSocket|EventSource/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import/);
  });

  test("a `</script>` inside something that was said cannot close the data slot early", () => {
    const nasty: CallLogContents = {
      summary: SUMMARY,
      records: [
        { type: "opened", at: SUMMARY.startedAt, ...SUMMARY },
        {
          type: "said",
          at: SUMMARY.startedAt,
          who: "user",
          text: "read the file with </script><script>alert(1)</script> in it",
        },
      ],
    };
    const html = renderCallLog(nasty);
    expect(html).not.toContain("</script><script>alert(1)");
    const said = payload(html).entries[1] as { text: string };
    expect(said.text).toContain("</script>");
  });

  test("a `$&` in something that was said survives the slot substitution intact", () => {
    const dollars: CallLogContents = {
      summary: SUMMARY,
      records: [
        { type: "opened", at: SUMMARY.startedAt, ...SUMMARY },
        { type: "said", at: SUMMARY.startedAt, who: "user", text: "grep for $& and $' please" },
      ],
    };
    const said = payload(renderCallLog(dollars)).entries[1] as { text: string };
    expect(said.text).toBe("grep for $& and $' please");
  });

  test("the page's inline script parses — a syntax error there renders a blank page", () => {
    const html = renderCallLog(CONTENTS);
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
    expect(blocks.length).toBeGreaterThan(0);
    // Parsed, never run: there is no DOM here, and the point is to catch a typo that would leave
    // the reader looking at an empty page with the whole record sitting unused in the data slot.
    for (const block of blocks) expect(() => new Function(block)).not.toThrow();
  });
});
