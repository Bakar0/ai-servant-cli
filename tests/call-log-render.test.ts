import { describe, expect, test } from "bun:test";
import type { CallLogEntry } from "../src/core/call-log/record.ts";
import { CALL_LOG_TEMPLATE } from "../src/core/call-log/template.ts";
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
  steers: 0,
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

  test("drops the asking half of a round trip the answer already covers", () => {
    const asked: CallLogContents = {
      summary: SUMMARY,
      records: [
        { type: "hands-asked", at: "2026-08-09T10:46:56.000Z", request: "run the tests" },
        ...CONTENTS.records.slice(5),
      ],
    };
    const entries = buildCallLogViewData(asked).entries;
    expect(entries.filter((e) => e.type === "hands-asked")).toEqual([]);
    expect(entries.filter((e) => e.type === "hands")).toHaveLength(1);
  });

  test("a failure with no question in front of it does not answer someone else's question", () => {
    const killed: CallLogContents = {
      summary: SUMMARY,
      records: [
        { type: "hands-asked", at: "2026-08-09T10:46:56.000Z", request: "run the whole suite" },
        // `ask_hands` called with unreadable arguments: an answer, but to nothing that was asked.
        {
          type: "hands",
          at: "2026-08-09T10:46:57.000Z",
          request: "",
          response: 'ask_hands needs a non-empty "request" argument.',
          outcome: "error",
          durationMs: 1,
        },
      ],
    };
    const entries = buildCallLogViewData(killed).entries;
    expect(entries.filter((e) => e.type === "hands-asked")).toHaveLength(1);
  });

  test("two requests in flight at once are each paired with their own answer", () => {
    const overlapping: CallLogContents = {
      summary: SUMMARY,
      records: [
        { type: "hands-asked", at: "2026-08-09T10:46:00.000Z", request: "run the suite" },
        { type: "hands-asked", at: "2026-08-09T10:46:01.000Z", request: "run the linter" },
        {
          type: "hands",
          at: "2026-08-09T10:47:00.000Z",
          request: "run the suite",
          response: "all green",
          outcome: "ok",
          durationMs: 60_000,
        },
        {
          type: "hands",
          at: "2026-08-09T10:47:30.000Z",
          request: "run the linter",
          response: "clean",
          outcome: "ok",
          durationMs: 90_000,
        },
      ],
    };
    // Paired by position, the second request would survive as a false "no answer came back".
    expect(
      buildCallLogViewData(overlapping).entries.filter((e) => e.type === "hands-asked"),
    ).toEqual([]);
  });

  test("drops the sending half of a steer the outcome already covers", () => {
    const steered: CallLogContents = {
      summary: SUMMARY,
      records: [
        {
          type: "steer-sent",
          at: "2026-08-09T10:46:56.000Z",
          target: "demo-t23",
          instruction: "rebase onto main first",
        },
        {
          type: "steer",
          at: "2026-08-09T10:47:00.000Z",
          target: "demo-t23",
          instruction: "rebase onto main first",
          status: "delivered",
          durationMs: 4000,
        },
      ],
    };
    const entries = buildCallLogViewData(steered).entries;
    expect(entries.filter((e) => e.type === "steer-sent")).toEqual([]);
    expect(entries.filter((e) => e.type === "steer")).toHaveLength(1);
  });

  // A Summons killed mid-relay is the case reading it back cannot otherwise show: the instruction
  // went out and nothing here says whether it landed.
  test("keeps a steer that never came back", () => {
    const cutOff: CallLogContents = {
      summary: SUMMARY,
      records: [
        {
          type: "steer-sent",
          at: "2026-08-09T10:46:56.000Z",
          target: "demo-t23",
          instruction: "rebase onto main first",
        },
      ],
    };
    expect(buildCallLogViewData(cutOff).entries).toHaveLength(1);
  });

  test("the same instruction to two sessions pairs each with its own outcome", () => {
    const both: CallLogContents = {
      summary: SUMMARY,
      records: [
        {
          type: "steer-sent",
          at: "2026-08-09T10:46:00.000Z",
          target: "demo-t23",
          instruction: "rebase first",
        },
        {
          type: "steer-sent",
          at: "2026-08-09T10:46:01.000Z",
          target: "demo-t26",
          instruction: "rebase first",
        },
        {
          type: "steer",
          at: "2026-08-09T10:47:00.000Z",
          target: "demo-t26",
          instruction: "rebase first",
          status: "delivered",
          durationMs: 1000,
        },
      ],
    };
    const left = buildCallLogViewData(both).entries.filter((e) => e.type === "steer-sent");
    expect(left).toHaveLength(1);
    expect((left[0] as { target: string }).target).toBe("demo-t23");
  });

  test("keeps a request no answer ever followed — the one case only it can show", () => {
    const killed: CallLogContents = {
      summary: { ...SUMMARY, endedAt: null, endReason: null, handsCalls: 0 },
      records: [
        { type: "opened", at: SUMMARY.startedAt, ...SUMMARY },
        { type: "hands-asked", at: "2026-08-09T10:46:56.000Z", request: "run the whole suite" },
      ],
    };
    expect(buildCallLogViewData(killed).entries).toHaveLength(2);
  });
});

/**
 * The page's renderer is browser-only inline JS with `default: return null`, so an entry type it
 * has no case for is dropped in silence — the record keeps it and the page just never shows it.
 * There is no DOM harness in this repo to catch that, so this is the guard: the compiler forces
 * the list to stay complete, and the test forces the template to keep up with it.
 */
describe("the page renders every kind of entry", () => {
  // Adding a kind to `CallLogEntry` breaks this object until it is listed, which is the point:
  // "row" means the timeline switch must have a case, "elsewhere" means the page renders it
  // some other way (`ended` becomes the footer, via an early return before the switch).
  const EVERY_ENTRY_TYPE: Record<CallLogEntry["type"], "row" | "elsewhere"> = {
    said: "row",
    tool: "row",
    gate: "row",
    delegation: "row",
    "hands-asked": "row",
    hands: "row",
    "steer-sent": "row",
    steer: "row",
    note: "row",
    ended: "elsewhere",
  };

  const rows = Object.entries(EVERY_ENTRY_TYPE)
    .filter(([, how]) => how === "row")
    .map(([type]) => type);

  test.each(rows)("the timeline switch has a case for %p", (type) => {
    expect(CALL_LOG_TEMPLATE).toContain(`case "${type}":`);
  });

  test("the kinds that skip the timeline are skipped on purpose, not by omission", () => {
    expect(CALL_LOG_TEMPLATE).toContain('entry.type === "ended"');
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
    const transpiler = new Bun.Transpiler({ loader: "js" });
    for (const block of blocks) expect(() => transpiler.transformSync(block)).not.toThrow();
  });
});
