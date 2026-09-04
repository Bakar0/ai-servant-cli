import { describe, expect, test } from "bun:test";
import { narrateMarkdown, narrateToSegments } from "../src/core/narrate.ts";
import type { EarCopyModel, NarrationEvent } from "../src/core/narrate.ts";

/** A model that replays a scripted answer in small deltas, and remembers what it was asked. */
function fakeModel(reply: (user: string) => string): EarCopyModel & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async *stream({ user }) {
      asked.push(user);
      const text = reply(user);
      for (let at = 0; at < text.length; at += 7) yield text.slice(at, at + 7);
    },
  };
}

async function events(markdown: string, model?: EarCopyModel): Promise<NarrationEvent[]> {
  const collected: NarrationEvent[] = [];
  for await (const event of narrateMarkdown(markdown, { model })) collected.push(event);
  return collected;
}

describe("narrating a Turn", () => {
  test("a heading never costs a round trip", async () => {
    const model = fakeModel(() => "The rewrite is streamed.");
    const segments = await narrateToSegments("## Where it stands\n\nSome prose.", { model });
    expect(model.asked).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "beat", text: "Where it stands" });
  });

  test("the heading above a paragraph travels with it", async () => {
    const model = fakeModel(() => "Fine.");
    await narrateToSegments("## Where it stands\n\nSome prose.", { model });
    expect(model.asked[0]).toContain("Where it stands");
  });

  test("sentences are released before their segment closes", async () => {
    const model = fakeModel(() => "First sentence. Second sentence.");
    const stream = await events("Some prose.", model);
    expect(stream.map((event) => event.type)).toEqual(["sentence", "sentence", "segment"]);
    expect(stream.filter((event) => event.type === "sentence").map((event) => event.text)).toEqual([
      "First sentence.",
      "Second sentence.",
    ]);
  });

  test("a segment is the sentences it released, joined", async () => {
    const model = fakeModel(() => "First sentence. Second sentence.");
    const segments = await narrateToSegments("Some prose.", { model });
    expect(segments[0]?.text).toBe("First sentence. Second sentence.");
  });

  test("a segment keeps the cues of the block it came from", async () => {
    const model = fakeModel(() => "It landed in a file path.");
    const segments = await narrateToSegments("It landed in src/core/narrate.ts.", { model });
    expect(segments[0]?.cues[0]).toMatchObject({ node: "path", fate: "reference" });
  });
});

describe("what the model is not allowed to get away with", () => {
  test("a path the model wrote itself never reaches the ear", async () => {
    const model = fakeModel(() => "It is defined in src/core/narrate.ts near the top.");
    const segments = await narrateToSegments("Some prose about the module.", { model });
    expect(segments[0]?.text).not.toContain("src/core/narrate.ts");
    expect(segments[0]?.leaked?.[0]).toMatchObject({ kind: "path" });
  });

  test("the failure is loud: it has its own event, naming the segment", async () => {
    const model = fakeModel(() => "Look at README.md for more.");
    const stream = await events("## A beat\n\nSome prose.", model);
    expect(stream.filter((event) => event.type === "leak")).toEqual([
      { type: "leak", segment: 1, leaks: [{ kind: "path", text: "README.md" }] },
    ]);
  });

  test("a failed segment falls back to its Cue rather than going silent", async () => {
    const model = fakeModel(() => "It reads /etc/hosts first.");
    const segments = await narrateToSegments("```ts\nconst x = 1;\n```", { model });
    expect(segments[0]?.text).toBe("There's a code block here.");
    expect(segments[0]?.cues[0]?.node).toBe("code");
  });

  test("one bad segment does not take the rest of the Turn down with it", async () => {
    let call = 0;
    const model = fakeModel(() => (++call === 1 ? "It is in src/core/narrate.ts." : "All fine."));
    const segments = await narrateToSegments("First para.\n\nSecond para.", { model });
    expect(segments).toHaveLength(2);
    expect(segments[0]?.leaked).not.toBeUndefined();
    expect(segments[1]?.text).toBe("All fine.");
    expect(segments[1]?.leaked).toBeUndefined();
  });

  test("a conversational tail never reaches the ear", async () => {
    const model = fakeModel(() => "The fix landed. If you want, I can walk through the tests.");
    const segments = await narrateToSegments("Some prose.", { model });
    expect(segments[0]?.text).toBe("The fix landed.");
  });

  test("a model that says nothing at all still cues the node it swallowed", async () => {
    const model = fakeModel(() => "");
    const segments = await narrateToSegments("| a | b |\n|---|---|\n| 1 | 2 |", { model });
    expect(segments[0]?.text).toBe("There's a table here.");
    expect(segments[0]?.cues[0]?.node).toBe("table");
  });
});

describe("with no model in the path", () => {
  test("the Turn is still narrated, and still cues its skips", async () => {
    const segments = await narrateToSegments(
      "## Results\n\nIt landed in `src/core/narrate.ts` today.\n\n```ts\nconst x = 1;\n```",
    );
    expect(segments.map((segment) => segment.text)).toEqual([
      "Results",
      "It landed in the narrate file today.",
      "There's a code block here.",
    ]);
  });

  test("an empty Turn narrates to nothing", async () => {
    expect(await narrateToSegments("   \n\n")).toEqual([]);
  });
});
