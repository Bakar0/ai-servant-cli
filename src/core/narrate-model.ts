import type { EarCopyModel } from "./narrate.ts";

// The one network hop in the text half. Kept behind `EarCopyModel` so every test in this feature
// runs offline, and so `say`-style offline engines stay possible later (workspace ADR 0001).

const COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Measured on this machine against a 64-word paragraph: 3.0–4.2s to rewrite. `gpt-5-mini` took
 * 17.5–19.3s and closed with an offer to help, so it is rejected on both speed and behaviour.
 */
export const DEFAULT_EAR_COPY_MODEL = "gpt-4o-mini";

export interface OpenAiEarCopyOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
}

export function createOpenAiEarCopyModel(options: OpenAiEarCopyOptions): EarCopyModel {
  const call = options.fetch ?? fetch;
  const model = options.model ?? DEFAULT_EAR_COPY_MODEL;
  return {
    async *stream({ system, user }) {
      const response = await call(COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          // Narration wants the same words for the same paragraph, so Pre-warm and the cache are
          // worth having. The gpt-5 family rejects any temperature but its default, so it is
          // omitted there rather than sent and refused.
          ...(model.startsWith("gpt-5") ? {} : { temperature: 0.3 }),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Ear-copy rewrite failed: ${response.status} ${await response.text()}`);
      }
      for await (const delta of readDeltas(response.body)) yield delta;
    },
  };
}

/** Server-sent events, reassembled across chunk boundaries — a `data:` line can arrive in halves. */
async function* readDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const text = parsed.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        // A malformed frame costs one delta, not the whole Narration.
      }
    }
  }
}
