import { getBackend } from "../agents/index.ts";

/** Resolve the producing backend from the transcript, never a mutable workspace preference. */
export async function sessionBackend(transcriptPath: string, explicit?: string): Promise<string> {
  if (explicit) return getBackend(explicit).name;
  // Only read the header, even for a very large transcript. Legacy queue jobs have no backend.
  const header = await Bun.file(transcriptPath)
    .slice(0, 64 * 1024)
    .text();
  for (const line of header.split("\n")) {
    try {
      const record = JSON.parse(line) as { type?: string } | null;
      if (
        record?.type === "session_meta" ||
        record?.type === "response_item" ||
        record?.type === "turn_context"
      )
        return "codex";
      if (record?.type && ["user", "assistant", "system"].includes(record.type))
        return "claude-code";
    } catch {
      // Ignore partial or malformed header lines.
    }
  }
  throw new Error(`Cannot identify the agent that produced ${transcriptPath}.`);
}
