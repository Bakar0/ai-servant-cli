import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { insightsIndexPath, insightsMetricsDir, insightsRoot } from "../paths.ts";
import { METRICS_SCHEMA_VERSION, type SessionMetrics, extractSessionMetrics } from "./metrics.ts";

export { type ChangeEntry, appendChange, readChanges } from "./changes.ts";

// The insights store mirrors the knowledge store's lifecycle: a git-tracked dir under the servant
// root, mkdir + git-init on first use, GIT_IDENTITY commits that no-op when clean. It holds one
// deterministic metrics record per session (cached by session-id + mtime) plus an append-only
// change ledger that maps setup-fingerprint transitions to what changed.

function gitInitialized(): boolean {
  return existsSync(join(insightsRoot(), ".git"));
}

/** Create the store dirs and git-init on first use. Idempotent and cheap. */
export async function ensureInsightsStore(): Promise<void> {
  await mkdir(insightsMetricsDir(), { recursive: true });
  if (!gitInitialized()) {
    await $`git -C ${insightsRoot()} init -q`.nothrow().quiet();
  }
}

const GIT_IDENTITY = ["-c", "user.name=servant", "-c", "user.email=servant@localhost"];

/** Stage everything under insights/ and commit. No-op if nothing changed. */
export async function commitInsights(message: string): Promise<void> {
  const root = insightsRoot();
  if (!gitInitialized()) return;
  await $`git -C ${root} add -A`.nothrow().quiet();
  const status = await $`git -C ${root} status --porcelain`.nothrow().quiet();
  if (status.stdout.toString().trim() === "") return;
  await $`git -C ${root} ${GIT_IDENTITY} commit -q -m ${message}`.nothrow().quiet();
}

// --- Metric record cache (keyed by session-id + mtime) ---

function metricPath(sessionId: string): string {
  return join(insightsMetricsDir(), `${sessionId}.json`);
}

async function readCachedMetric(sessionId: string): Promise<SessionMetrics | null> {
  try {
    const parsed = JSON.parse(await readFile(metricPath(sessionId), "utf8")) as SessionMetrics;
    return parsed.schema === METRICS_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

async function writeMetric(record: SessionMetrics): Promise<void> {
  await mkdir(insightsMetricsDir(), { recursive: true });
  await writeFile(metricPath(record.sessionId), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Return the metrics record for a transcript, recomputing only when the cached record is missing,
 * schema-stale, or the transcript's mtime moved. The expensive transcript parse runs at most once
 * per (session, mtime).
 */
export async function getOrComputeMetrics(
  jsonlPath: string,
  mtimeMs: number,
): Promise<SessionMetrics> {
  const sessionId = jsonlPath.replace(/^.*\//, "").replace(/\.jsonl$/, "");
  const cached = await readCachedMetric(sessionId);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const record = await extractSessionMetrics(jsonlPath);
  await writeMetric(record);
  return record;
}

/** Write the thin digest snapshot (regenerated, like knowledge/INDEX.md). */
export async function rebuildInsightsIndex(body: string): Promise<void> {
  await mkdir(insightsRoot(), { recursive: true });
  await writeFile(insightsIndexPath(), body.endsWith("\n") ? body : `${body}\n`);
}
