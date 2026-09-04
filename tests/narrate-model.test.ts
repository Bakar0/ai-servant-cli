import { describe, expect, test } from "bun:test";
import { createOpenAiEarCopyModel } from "../src/core/narrate-model.ts";

function respondWith(chunks: readonly string[], init: ResponseInit = {}): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      init,
    )) as unknown as typeof fetch;
}

function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

async function collect(model: {
  stream: (p: { system: string; user: string }) => AsyncIterable<string>;
}) {
  const deltas: string[] = [];
  for await (const delta of model.stream({ system: "s", user: "u" })) deltas.push(delta);
  return deltas;
}

describe("what gets sent", () => {
  async function capture(model?: string) {
    let sent: { url: string; init: RequestInit } | undefined;
    const client = createOpenAiEarCopyModel({
      apiKey: "sk-test",
      model,
      fetch: (async (url: string, init: RequestInit) => {
        sent = { url, init };
        return new Response(new ReadableStream({ start: (c) => c.close() }));
      }) as unknown as typeof fetch,
    });
    await collect(client);
    return {
      url: sent?.url ?? "",
      headers: sent?.init.headers as Record<string, string>,
      body: JSON.parse((sent?.init.body ?? "{}") as string) as Record<string, unknown>,
    };
  }

  test("the key travels as a bearer token, and the request streams", async () => {
    const { url, headers, body } = await capture();
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
  });

  test("the default is the model that met the budget", async () => {
    expect((await capture()).body.model).toBe("gpt-4o-mini");
  });

  test("temperature is pinned low, so a Turn narrates the same way twice", async () => {
    expect((await capture()).body.temperature).toBe(0.3);
  });

  test("except on gpt-5, which answers 400 to any temperature but its own", async () => {
    expect((await capture("gpt-5-mini")).body).not.toHaveProperty("temperature");
  });
});

describe("reading the stream back", () => {
  test("deltas arrive in order", async () => {
    const model = createOpenAiEarCopyModel({
      apiKey: "k",
      fetch: respondWith([frame("The fix "), frame("landed."), "data: [DONE]\n\n"]),
    });
    expect(await collect(model)).toEqual(["The fix ", "landed."]);
  });

  test("an event split across two chunks is still one delta", async () => {
    const whole = frame("landed.");
    const model = createOpenAiEarCopyModel({
      apiKey: "k",
      fetch: respondWith([whole.slice(0, 12), whole.slice(12)]),
    });
    expect(await collect(model)).toEqual(["landed."]);
  });

  test("a malformed frame costs one delta, not the whole Narration", async () => {
    const model = createOpenAiEarCopyModel({
      apiKey: "k",
      fetch: respondWith([frame("first "), "data: {not json}\n\n", frame("third")]),
    });
    expect(await collect(model)).toEqual(["first ", "third"]);
  });

  test("a refused request throws with the status the endpoint gave", async () => {
    const model = createOpenAiEarCopyModel({
      apiKey: "k",
      fetch: respondWith(['{"error":{"message":"nope"}}'], { status: 400 }),
    });
    expect(collect(model)).rejects.toThrow("400");
  });
});
