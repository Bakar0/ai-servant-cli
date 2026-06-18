import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { insightsChangesPath, insightsRoot } from "../paths.ts";

// The append-only change ledger: each entry records when an instruction asset or fine-tune overlay
// actually changed, so a setup-fingerprint transition in the digest can be attributed to a cause.
// Kept in its own module (depends only on paths) so the spawn-path writers — `writeOverlay` and
// `ensureServantAssets` — can append without pulling in the transcript-parsing subsystem.

export interface ChangeEntry {
  ts: number;
  kind: "asset" | "overlay";
  /** Asset rel-path or overlay aspect id. */
  id: string;
  /** The composed-setup fingerprint after the change (when computable). */
  fingerprint?: string;
  note?: string;
}

/** Append a change-ledger entry. Best-effort: never throws (callers run it on the spawn path). */
export async function appendChange(entry: ChangeEntry): Promise<void> {
  try {
    await mkdir(insightsRoot(), { recursive: true });
    const path = insightsChangesPath();
    const prev = existsSync(path) ? await readFile(path, "utf8") : "";
    await writeFile(path, `${prev}${JSON.stringify(entry)}\n`);
  } catch {
    // best-effort — a ledger write must never break a spawn
  }
}

export async function readChanges(): Promise<ChangeEntry[]> {
  const path = insightsChangesPath();
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const out: ChangeEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ChangeEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
